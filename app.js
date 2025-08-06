// Local AI Assistant - Single File Bun Application
// Uses Ollama for local AI processing with a web interface

// Import SQLite from Bun
import { Database } from 'bun:sqlite';

// Configuration
const PORT = 3000;
const OLLAMA_API_URL = "http://localhost:11434/api";
const DEFAULT_MODEL = "phi:latest"; // Default model if none selected
const DB_PATH = "chat_memory.sqlite";
const REFERENCE_SESSION_ID = "fixed_reference_session"; // Fixed session ID for references

// Initialize SQLite database
const db = new Database(DB_PATH);

// Create tables if they don't exist
db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at INTEGER,
    last_activity INTEGER
  )
`);

// Add title column if it doesn't exist (migration)
try {
  db.run(`ALTER TABLE sessions ADD COLUMN title TEXT DEFAULT 'New Chat'`);
  console.log("Added title column to sessions table");
} catch (error) {
  // Column already exists, which is fine
  if (!error.message.includes("duplicate column name")) {
    console.error("Error adding title column:", error);
  }
}

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    role TEXT,
    content TEXT,
    timestamp INTEGER,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS contexts (
    session_id TEXT PRIMARY KEY,
    context TEXT,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
  )
`);

// Create table for storing key user information
db.run(`
  CREATE TABLE IF NOT EXISTS user_info (
    session_id TEXT,
    key TEXT,
    value TEXT,
    timestamp INTEGER,
    PRIMARY KEY(session_id, key),
    FOREIGN KEY(session_id) REFERENCES sessions(id)
  )
`);

// Drop existing reference_contexts table if it exists
db.run(`DROP TABLE IF EXISTS reference_contexts`);

// Create table for storing reference contexts without foreign key constraint
db.run(`
  CREATE TABLE IF NOT EXISTS reference_contexts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    title TEXT,
    content TEXT,
    timestamp INTEGER,
    is_active INTEGER DEFAULT 1
  )
`);

// Log that we've recreated the reference_contexts table
console.log("Recreated reference_contexts table without foreign key constraint");

console.log(`📦 SQLite database initialized at ${DB_PATH}`);

// Legacy in-memory store (kept for fallback)
const sessions = new Map();

// Response cache for frequently asked questions
const responseCache = new Map();

// Function to fetch available models from Ollama
async function getAvailableModels() {
  try {
    const response = await fetch(`${OLLAMA_API_URL}/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`);
    }

    const data = await response.json();
    return data.models || [];
  } catch (error) {
    console.error("Error fetching available models:", error);
    return [];
  }
}

// Ollama API Integration
async function generateResponse(prompt, context = [], systemPrompt = "", modelName = DEFAULT_MODEL, sessionId = null) {
  try {
    console.log(`Generating response using model: ${modelName}`);
    
    // Check if Ollama is available with better error handling
    let healthCheck;
    try {
      healthCheck = await fetch(`${OLLAMA_API_URL}/version`, {
        method: "GET",
        signal: AbortSignal.timeout(5000) // 5-second timeout
      });
    } catch (connectionError) {
      console.error("Connection error checking Ollama availability:", connectionError);
      throw new Error("CONNECTION_REFUSED");
    }
    
    if (!healthCheck || !healthCheck.ok) {
      throw new Error("Ollama service is not available");
    }

    // Check cache first
    const cacheKey = `${modelName}:${prompt}`;
    const cachedResponse = responseCache.get(cacheKey);
    if (cachedResponse) {
      return cachedResponse;
    }
    
    // Get reference contexts for the current session but only use them if the prompt is related
    const referenceContexts = getReferenceContexts(sessionId).filter(ctx => ctx.is_active === 1);
    let enhancedPrompt = prompt;
    
    // Check if the prompt is related to any reference contexts
    if (referenceContexts.length > 0) {
      const isRelevant = referenceContexts.some(ctx => {
        const titleWords = ctx.title.toLowerCase().split(' ');
        const contentWords = ctx.content.toLowerCase().split(' ');
        const promptLower = prompt.toLowerCase();
        
        // Check if prompt mentions the reference title or key content words
        return titleWords.some(word => word.length > 2 && promptLower.includes(word)) ||
               contentWords.some(word => word.length > 3 && promptLower.includes(word));
      });
      
      // Only add reference information if the prompt is relevant
      if (isRelevant) {
        let referenceSection = "Here is some important reference information:\n\n";
        for (const ctx of referenceContexts) {
          referenceSection += `[${ctx.title}]\n${ctx.content}\n\n`;
        }
        referenceSection += "Based on the above reference information, please answer: ";
        
        // Prepend the reference information to the prompt
        enhancedPrompt = referenceSection + prompt;
        console.log("Enhanced prompt with relevant references:", enhancedPrompt);
      } else {
        console.log("References available but not relevant to this prompt");
      }
    }

    // Check if the model exists before making the generate request
    try {
      const modelsResponse = await fetch(`${OLLAMA_API_URL}/tags`, {
        method: "GET",
        signal: AbortSignal.timeout(5000)
      });
      
      if (!modelsResponse.ok) {
        throw new Error(`Failed to fetch models: ${modelsResponse.status}`);
      }
      
      const modelsData = await modelsResponse.json();
      const availableModels = modelsData.models || [];
      const modelExists = availableModels.some(m => m.name === modelName);
      
      if (!modelExists) {
        throw new Error(`Model "${modelName}" not found in available models`);
      }
      
      console.log(`Model "${modelName}" is available, proceeding with request`);
    } catch (modelCheckError) {
      console.error("Error checking model availability:", modelCheckError);
      throw new Error(`Model "${modelName}" not found or unavailable: ${modelCheckError.message}`);
    }

    // Handle model names with special characters
    let modelToUse = modelName;
    
    // If model name contains special characters, try to use a simplified version
    if (modelName.includes(":")) {
      const simplifiedName = modelName.split(":")[0];
      console.log(`Model name contains special characters, will try with simplified name "${simplifiedName}" if needed`);
      
      // First try with the original name
      try {
        console.log(`Attempting request with original model name: ${modelName}`);
        const response = await fetch(`${OLLAMA_API_URL}/generate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: modelName,
            prompt: enhancedPrompt,
            system: systemPrompt,
            context: context,
            stream: false,
          }),
          signal: AbortSignal.timeout(30000) // 30-second timeout for generation
        });
        
        if (!response.ok) {
          throw new Error(`Ollama API error: ${response.status}`);
        }
        
        const data = await response.json();
        console.log(`Successfully received response from model: ${modelName}`);
        
        const result = {
          content: data.response,
          context: data.context,
        };
        
        // Cache the response
        responseCache.set(cacheKey, result);
        
        // Limit cache size
        if (responseCache.size > 100) {
          const oldestKey = responseCache.keys().next().value;
          responseCache.delete(oldestKey);
        }
        
        return result;
      } catch (originalModelError) {
        console.error(`Error with original model name "${modelName}":`, originalModelError);
        console.log(`Falling back to simplified model name: ${simplifiedName}`);
        
        // If original name fails, try with simplified name
        modelToUse = simplifiedName;
      }
    }
    
    // If we're here, either we're using a model without special chars,
    // or we're trying the simplified name as a fallback
    console.log(`Sending request to Ollama API for model: ${modelToUse}`);
    const response = await fetch(`${OLLAMA_API_URL}/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelToUse,
        prompt: enhancedPrompt,
        system: systemPrompt,
        context: context,
        stream: false,
      }),
      signal: AbortSignal.timeout(30000) // 30-second timeout for generation
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorData = {};
      try {
        errorData = JSON.parse(errorText);
      } catch (e) {
        // If parsing fails, use the raw text
        errorData = { error: errorText };
      }
      
      console.error(`Ollama API error response: ${response.status}`, errorData);
      throw new Error(`Ollama API error: ${response.status} - ${errorData.error || "Unknown error"}`);
    }

    const data = await response.json();
    console.log(`Successfully received response from model: ${modelToUse}`);
    
    const result = {
      content: data.response,
      context: data.context,
    };

    // Cache the response
    responseCache.set(cacheKey, result);
    
    // Limit cache size
    if (responseCache.size > 100) {
      const oldestKey = responseCache.keys().next().value;
      responseCache.delete(oldestKey);
    }

    return result;
  } catch (error) {
    console.error(`Error calling Ollama API with model ${modelName}:`, error);
    
    // Check if this is actually a connection error by examining the error more carefully
    const isConnectionError = (
      error.message === "CONNECTION_REFUSED" ||
      error.code === "ConnectionRefused" ||
      error.name === "ConnectionRefused" ||
      error.errno === "ECONNREFUSED" ||
      (error.cause && error.cause.code === "ECONNREFUSED") ||
      (error.message && error.message.includes("ECONNREFUSED")) ||
      (error.toString().includes("ECONNREFUSED"))
    );
    
    // Check if this is a timeout error
    const isTimeoutError = (
      error.name === "TimeoutError" ||
      error.message.includes("timeout") ||
      error.message.includes("aborted") ||
      error.code === "TIMEOUT" ||
      (error.cause && error.cause.name === "TimeoutError")
    );
    
    // Provide helpful error messages based on error type
    if (isTimeoutError) {
      return {
        content: `The ${modelName} model is taking too long to respond (timeout). This model might be slow to load or having issues. Try using a different model like "phi:latest" or "mistral:7b" which may be more responsive.`,
        context: context,
      };
    } else if (isConnectionError) {
      
      // Special handling for model names with special characters
      if (modelName.includes(":")) {
        const simplifiedName = modelName.split(":")[0];
        return {
          content: `I'm having trouble connecting to the model "${modelName}". This may be due to special characters in the model name. Try using a simplified model name without colons (e.g., "${simplifiedName}") or run "ollama pull ${simplifiedName}" to download a model without special characters.`,
          context: context,
        };
      } else {
        return {
          content: "I cannot connect to the Ollama service. Please make sure Ollama is running on your computer by opening the Ollama application first, then refresh this page and try again.",
          context: context,
        };
      }
    } else if (error.message.includes("not available")) {
      return {
        content: "I'm having trouble connecting to the Ollama service. Please make sure Ollama is running and try again.",
        context: context,
      };
    } else if (error.message.includes("not found") || error.message.includes("unavailable")) {
      // If model has special characters, suggest a simplified version
      if (modelName.includes(":")) {
        const simplifiedName = modelName.split(":")[0];
        return {
          content: `The model "${modelName}" was not found or is unavailable. This may be due to special characters in the model name. Try using a simplified model name (e.g., "${simplifiedName}") or run "ollama pull ${simplifiedName}" to download a model without special characters.`,
          context: context,
        };
      } else {
        return {
          content: `The model "${modelName}" was not found or is unavailable. Please make sure it's downloaded using "ollama pull ${modelName}" and try again.`,
          context: context,
        };
      }
    } else if (error.message.includes("context length")) {
      return {
        content: `The conversation is too long for the ${modelName} model. Please try clearing the chat history or using a model with larger context window.`,
        context: context,
      };
    } else {
      // Log the actual error for debugging
      console.error("Unhandled error in generateResponse:", error);
      console.error("Error type:", typeof error);
      console.error("Error properties:", Object.keys(error));
      console.error("Error message:", error.message);
      console.error("Error stack:", error.stack);
      
      // For any other errors, provide a generic response without mentioning special characters
      // unless it's actually a model-related error
      if (error.message && (error.message.includes("model") || error.message.includes("Model"))) {
        if (modelName.includes(":")) {
          const simplifiedName = modelName.split(":")[0];
          return {
            content: `I encountered an error while using the ${modelName} model. This might be because the model name contains special characters. Try using a simplified model name (e.g., "${simplifiedName}") or run "ollama pull ${simplifiedName}" to download a model without special characters.`,
            context: context,
          };
        } else {
          return {
            content: `I encountered an error while using the ${modelName} model. Please make sure Ollama is running and you've downloaded the model with "ollama pull ${modelName}".`,
            context: context,
          };
        }
      } else {
        // For non-model-specific errors, provide a generic response
        return {
          content: `I encountered an unexpected error while processing your request. Please try again, and if the problem persists, check that Ollama is running properly.`,
          context: context,
        };
      }
    }
  }
}

// Session Management Functions with SQLite persistence
function getOrCreateSession(sessionId, title = 'New Chat') {
  try {
    const now = Date.now();
    
    // Check if session exists
    const existingSession = db.query('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    
    if (!existingSession) {
      // Create new session
      db.run('INSERT INTO sessions (id, title, created_at, last_activity) VALUES (?, ?, ?, ?)',
        [sessionId, title, now, now]);
      return {
        id: sessionId,
        title,
        messages: [],
        context: null,
        createdAt: now,
        lastActivity: now
      };
    }
    
    // Update last activity
    db.run('UPDATE sessions SET last_activity = ? WHERE id = ?', [now, sessionId]);
    
    // Get messages
    const messages = db.query('SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp').all(sessionId);
    
    // Get context
    const contextRow = db.query('SELECT context FROM contexts WHERE session_id = ?').get(sessionId);
    const context = contextRow ? JSON.parse(contextRow.context) : null;
    
    return {
      id: sessionId,
      title: existingSession.title || 'New Chat',
      messages,
      context,
      createdAt: existingSession.created_at,
      lastActivity: now
    };
  } catch (error) {
    console.error("SQLite error in getOrCreateSession:", error);
    // Fallback to in-memory if database fails
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, {
        messages: [],
        context: null,
        createdAt: Date.now(),
        lastActivity: Date.now()
      });
    }
    return sessions.get(sessionId);
  }
}

// Get all sessions for dashboard
function getAllSessions() {
  try {
    const sessions = db.query(`
      SELECT
        s.id,
        s.title,
        s.created_at,
        s.last_activity,
        COUNT(m.id) as message_count
      FROM sessions s
      LEFT JOIN messages m ON s.id = m.session_id
      GROUP BY s.id, s.title, s.created_at, s.last_activity
      ORDER BY s.last_activity DESC
    `).all();
    
    return sessions;
  } catch (error) {
    console.error("SQLite error in getAllSessions:", error);
    return [];
  }
}

// Delete a session and all its data
function deleteSession(sessionId) {
  try {
    db.transaction(() => {
      db.run('DELETE FROM messages WHERE session_id = ?', [sessionId]);
      db.run('DELETE FROM contexts WHERE session_id = ?', [sessionId]);
      db.run('DELETE FROM user_info WHERE session_id = ?', [sessionId]);
      db.run('DELETE FROM reference_contexts WHERE session_id = ?', [sessionId]);
      db.run('DELETE FROM sessions WHERE id = ?', [sessionId]);
    })();
    
    return true;
  } catch (error) {
    console.error("SQLite error in deleteSession:", error);
    return false;
  }
}

// Update session title
function updateSessionTitle(sessionId, title) {
  try {
    db.run('UPDATE sessions SET title = ? WHERE id = ?', [title, sessionId]);
    return true;
  } catch (error) {
    console.error("SQLite error in updateSessionTitle:", error);
    return false;
  }
}

function addMessageToSession(sessionId, role, content) {
  try {
    const timestamp = Date.now();
    
    // Insert message into database
    db.run('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
      [sessionId, role, content, timestamp]);
    
    // Update session last activity
    db.run('UPDATE sessions SET last_activity = ? WHERE id = ?', [timestamp, sessionId]);
    
    // Get updated session
    const session = getOrCreateSession(sessionId);
    
    // Clean up old sessions
    cleanupOldSessions();
    
    return session;
  } catch (error) {
    console.error("SQLite error in addMessageToSession:", error);
    // Fallback to in-memory if database fails
    const session = sessions.get(sessionId) || {
      messages: [],
      context: null,
      createdAt: Date.now(),
      lastActivity: Date.now()
    };
    
    session.messages.push({
      role,
      content,
      timestamp: Date.now()
    });
    session.lastActivity = Date.now();
    sessions.set(sessionId, session);
    
    return session;
  }
}

function updateSessionContext(sessionId, context) {
  try {
    // Serialize context to JSON
    const contextJson = JSON.stringify(context);
    
    // Insert or replace context in database
    db.run('INSERT OR REPLACE INTO contexts (session_id, context) VALUES (?, ?)',
      [sessionId, contextJson]);
    
    // Update session last activity
    db.run('UPDATE sessions SET last_activity = ? WHERE id = ?', [Date.now(), sessionId]);
    
    // Get updated session
    return getOrCreateSession(sessionId);
  } catch (error) {
    console.error("SQLite error in updateSessionContext:", error);
    // Fallback to in-memory if database fails
    const session = sessions.get(sessionId);
    if (session) {
      session.context = context;
      session.lastActivity = Date.now();
    }
    return session;
  }
}

function getSessionHistory(sessionId) {
  try {
    // Get messages from database
    const messages = db.query('SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp').all(sessionId);
    return messages;
  } catch (error) {
    console.error("SQLite error in getSessionHistory:", error);
    // Fallback to in-memory if database fails
    const session = sessions.get(sessionId);
    return session ? session.messages : [];
  }
}

function getSessionContext(sessionId) {
  try {
    // Get context from database
    const contextRow = db.query('SELECT context FROM contexts WHERE session_id = ?').get(sessionId);
    return contextRow ? JSON.parse(contextRow.context) : null;
  } catch (error) {
    console.error("SQLite error in getSessionContext:", error);
    // Fallback to in-memory if database fails
    const session = sessions.get(sessionId);
    return session ? session.context : null;
  }
}

// Function to clean up contaminated conversation history
function cleanupContaminatedSessions() {
  try {
    console.log("Cleaning up contaminated conversation history...");
    
    // Get all sessions
    const allSessions = db.query('SELECT id FROM sessions').all();
    
    let cleanedCount = 0;
    
    allSessions.forEach(session => {
      const sessionId = session.id;
      
      // Get messages for this session
      const messages = db.query('SELECT id, content, role FROM messages WHERE session_id = ? ORDER BY timestamp', [sessionId]).all();
      
      // Find contaminated assistant messages
      const contaminatedMessages = messages.filter(msg => {
        if (msg.role !== 'assistant') return false;
        
        const content = msg.content.toLowerCase();
        const errorPatterns = [
          'having trouble connecting',
          'special characters in the model name',
          'connection refused',
          'ollama is not running',
          'model not found',
          'unable to connect',
          'try using a simplified model name',
          'run "ollama pull'
        ];
        
        return errorPatterns.some(pattern => content.includes(pattern));
      });
      
      // Delete contaminated messages
      if (contaminatedMessages.length > 0) {
        console.log(`Cleaning ${contaminatedMessages.length} contaminated messages from session ${sessionId}`);
        
        contaminatedMessages.forEach(msg => {
          db.run('DELETE FROM messages WHERE id = ?', [msg.id]);
        });
        
        cleanedCount += contaminatedMessages.length;
      }
    });
    
    console.log(`Cleanup complete. Removed ${cleanedCount} contaminated messages.`);
    
  } catch (error) {
    console.error("Error during cleanup:", error);
  }
}

function cleanupOldSessions() {
  try {
    const now = Date.now();
    const MAX_SESSION_AGE = 24 * 60 * 60 * 1000; // 24 hours
    const cutoff = now - MAX_SESSION_AGE;
    
    // Get expired sessions
    const expiredSessions = db.query('SELECT id FROM sessions WHERE last_activity < ?').all(cutoff);
    
    // Delete expired sessions and their related data
    db.transaction(() => {
      expiredSessions.forEach(session => {
        const sessionId = session.id;
        db.run('DELETE FROM messages WHERE session_id = ?', [sessionId]);
        db.run('DELETE FROM contexts WHERE session_id = ?', [sessionId]);
        db.run('DELETE FROM sessions WHERE id = ?', [sessionId]);
      });
    })();
    
    // Also clean up in-memory sessions (fallback)
    for (const [sessionId, session] of sessions.entries()) {
      if (now - session.lastActivity > MAX_SESSION_AGE) {
        sessions.delete(sessionId);
      }
    }
  } catch (error) {
    console.error("SQLite error in cleanupOldSessions:", error);
  }
}

// Store key user information
function storeUserInfo(sessionId, key, value) {
  try {
    const timestamp = Date.now();
    
    // Insert or replace user info in database
    db.run('INSERT OR REPLACE INTO user_info (session_id, key, value, timestamp) VALUES (?, ?, ?, ?)',
      [sessionId, key, value, timestamp]);
    
    console.log(`Stored user info: ${key}=${value} for session ${sessionId}`);
  } catch (error) {
    console.error("SQLite error in storeUserInfo:", error);
  }
}

// Get user information
function getUserInfo(sessionId) {
  try {
    // Get all user info for this session
    const userInfo = db.query('SELECT key, value FROM user_info WHERE session_id = ? ORDER BY timestamp').all(sessionId);
    
    // Convert to object
    const infoObject = {};
    userInfo.forEach(info => {
      infoObject[info.key] = info.value;
    });
    
    return infoObject;
  } catch (error) {
    console.error("SQLite error in getUserInfo:", error);
    return {};
  }
}

// Reference context management functions
function getReferenceContexts(sessionId) {
  try {
    console.log(`Retrieving reference contexts for session ID: "${sessionId}"`);
    
    // Check if the session exists in the database
    const sessionExists = db.query('SELECT id FROM sessions WHERE id = ?').get(sessionId);
    console.log(`Session exists in database: ${!!sessionExists}`);
    
    // Check if there are any reference contexts in the database
    const allReferences = db.query('SELECT COUNT(*) as count FROM reference_contexts').get();
    console.log(`Total reference contexts in database: ${allReferences.count}`);
    
    // Try a direct query to get the specific reference we know exists
    const directReference = db.query('SELECT * FROM reference_contexts WHERE id = 1').all();
    console.log("Direct query for reference with ID 1:", JSON.stringify(directReference, null, 2));
    
    // Try a different approach - get all references and filter in code
    const allReferencesList = db.query('SELECT * FROM reference_contexts').all();
    console.log("All references in database (direct query):", JSON.stringify(allReferencesList, null, 2));
    
    // Get all reference contexts for this session with detailed logging
    console.log(`Executing SQL query: SELECT id, title, content, timestamp, is_active FROM reference_contexts WHERE session_id = '${sessionId}' ORDER BY timestamp DESC`);
    
    // Get all reference contexts for this session
    const results = db.query(
      'SELECT id, title, content, timestamp, is_active FROM reference_contexts WHERE session_id = ? ORDER BY timestamp DESC',
      [sessionId]
    ).all();
    
    console.log(`Found ${results.length} reference contexts for session ID: "${sessionId}"`);
    console.log("Raw results from database:", JSON.stringify(results, null, 2));
    
    // If the query didn't work, try a manual approach
    if (results.length === 0 && allReferencesList.length > 0) {
      console.log("Query returned no results, but references exist. Trying manual filtering...");
      const filteredResults = allReferencesList.filter(ref => ref.session_id === sessionId);
      console.log("Manually filtered results:", JSON.stringify(filteredResults, null, 2));
      
      if (filteredResults.length > 0) {
        console.log("Using manually filtered results instead");
        return filteredResults;
      }
    }
    
    if (results.length > 0) {
      console.log(`First reference: ID=${results[0].id}, Title=${results[0].title}`);
    }
    
    return results;
  } catch (error) {
    console.error("SQLite error in getReferenceContexts:", error);
    return [];
  }
}

function addReferenceContext(sessionId, title, content) {
  try {
    const timestamp = Date.now();
    
    console.log(`Adding reference context for session ID: "${sessionId}"`);
    console.log(`Title: "${title}", Content length: ${content.length} chars`);
    
    // Ensure the session exists in the database
    getOrCreateSession(sessionId);
    
    // Insert reference context into database
    console.log(`Executing SQL: INSERT INTO reference_contexts (session_id, title, content, timestamp, is_active) VALUES ('${sessionId}', '${title}', '...', ${timestamp}, 1)`);
    
    const result = db.run(
      'INSERT INTO reference_contexts (session_id, title, content, timestamp, is_active) VALUES (?, ?, ?, ?, 1)',
      [sessionId, title, content, timestamp]
    );
    
    console.log(`Added reference context with ID ${result.lastInsertRowid} for session ${sessionId}`);
    
    // Verify the reference was added by retrieving it
    const addedReference = db.query('SELECT * FROM reference_contexts WHERE id = ?').get(result.lastInsertRowid);
    console.log("Verification - Added reference:", JSON.stringify(addedReference, null, 2));
    
    return result.lastInsertRowid;
  } catch (error) {
    console.error("SQLite error in addReferenceContext:", error);
    return null;
  }
}

function toggleReferenceContext(id, isActive) {
  try {
    // Update reference context active status
    db.run('UPDATE reference_contexts SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, id]);
    return true;
  } catch (error) {
    console.error("SQLite error in toggleReferenceContext:", error);
    return false;
  }
}

function deleteReferenceContext(id) {
  try {
    // Delete reference context
    db.run('DELETE FROM reference_contexts WHERE id = ?', [id]);
    return true;
  } catch (error) {
    console.error("SQLite error in deleteReferenceContext:", error);
    return false;
  }
}

// Extract potential user information from messages
function extractUserInfo(sessionId, message) {
  // Simple pattern matching for common personal details
  // Name extraction
  const namePatterns = [
    /my name is ([A-Za-z\s]+)/i,
    /i am ([A-Za-z\s]+)/i,
    /call me ([A-Za-z\s]+)/i,
    /i'm ([A-Za-z\s]+)/i
  ];
  
  for (const pattern of namePatterns) {
    const match = message.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim();
      // Filter out common phrases that aren't actually names
      const nonNames = ['sorry', 'just', 'not sure', 'wondering', 'curious', 'interested', 'looking'];
      if (name.length > 1 && !nonNames.some(nonName => name.toLowerCase().includes(nonName))) {
        storeUserInfo(sessionId, 'name', name);
        break;
      }
    }
  }
  
  // Could add more extractors for other types of information
  // like location, preferences, etc.
}

function formatConversationForSystemPrompt(sessionId, maxMessages = 20) {
  const session = getOrCreateSession(sessionId);
  const recentMessages = session.messages.slice(-maxMessages);
  
  // Filter out error messages and problematic responses to prevent contamination
  const filteredMessages = recentMessages.filter(msg => {
    const content = msg.content.toLowerCase();
    
    // Skip messages that contain error patterns
    const errorPatterns = [
      'having trouble connecting',
      'special characters in the model name',
      'connection refused',
      'ollama is not running',
      'model not found',
      'unable to connect',
      'timeout',
      'failed to',
      'error',
      'try using a simplified model name',
      'run "ollama pull'
    ];
    
    // If this is an assistant message containing error patterns, skip it
    if (msg.role === 'assistant' && errorPatterns.some(pattern => content.includes(pattern))) {
      console.log(`Filtering out error message from history: ${msg.content.substring(0, 100)}...`);
      return false;
    }
    
    return true;
  });
  
  // If we filtered out too many messages, just use the last few user messages
  if (filteredMessages.length < 2 && recentMessages.length > 0) {
    const userMessages = recentMessages.filter(msg => msg.role === 'user').slice(-3);
    return userMessages.map(msg => `Human: ${msg.content}`).join('\n\n');
  }
  
  return filteredMessages.map(msg =>
    `${msg.role === 'user' ? 'Human' : 'Assistant'}: ${msg.content}`
  ).join('\n\n');
}

function createSystemPrompt(sessionId, modelName = DEFAULT_MODEL) {
  const conversationHistory = formatConversationForSystemPrompt(sessionId);
  const userInfo = getUserInfo(sessionId);
  
  console.log(`Creating system prompt for session ID: "${sessionId}"`);
  
  // Create user info section if we have any stored information
  let userInfoSection = '';
  if (Object.keys(userInfo).length > 0) {
    userInfoSection = 'Important user information you MUST remember:\n';
    for (const [key, value] of Object.entries(userInfo)) {
      userInfoSection += `- User's ${key}: ${value}\n`;
    }
    userInfoSection += '\n';
  }
  
  return `You are a helpful and friendly AI assistant. Be conversational, natural, and personable in your responses. Maintain memory of past interactions and reference relevant context when appropriate. Feel free to be casual and engaging while still being informative and helpful.

You are running locally using Ollama with the ${modelName} model.

${userInfoSection}Here is the recent conversation history for context:

${conversationHistory}

Please respond in a natural, conversational manner. Remember and use the user's name and personal details when available.`;
}

// HTML Template
const htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Local AI Assistant</title>
    <style>
        :root {
            --primary-color: #2563eb;
            --primary-hover: #1d4ed8;
            --secondary-color: #e5e7eb;
            --text-color: #1f2937;
            --light-text: #6b7280;
            --bg-color: #f8fafc;
            --chat-bg: #ffffff;
            --user-msg-bg: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            --ai-msg-bg: #ffffff;
            --border-color: #e2e8f0;
            --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
            --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
            --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
        }

        * {
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
            line-height: 1.6;
            color: var(--text-color);
            background: var(--bg-color);
            margin: 0;
            padding: 0;
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 0;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: var(--chat-bg);
            box-shadow: var(--shadow-lg);
        }

        header {
            background: var(--chat-bg);
            padding: 1rem;
            border-bottom: 1px solid var(--border-color);
            box-shadow: var(--shadow-sm);
            position: sticky;
            top: 0;
            z-index: 10;
        }

        h1 {
            margin: 0 0 0.75rem 0;
            font-size: 1.5rem;
            font-weight: 700;
            color: var(--primary-color);
            text-align: center;
        }

        .status-indicator {
            font-size: 0.75rem;
            color: var(--light-text);
            text-align: center;
            margin-top: 0.5rem;
            padding: 0.25rem 0.5rem;
            border-radius: 0.375rem;
            background: var(--bg-color);
        }

        .status-connected {
            color: #059669;
            background: #ecfdf5;
        }

        .status-disconnected {
            color: #dc2626;
            background: #fef2f2;
        }

        .chat-container {
            flex: 1;
            overflow-y: auto;
            overflow-x: hidden;
            padding: 1rem;
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
            background: var(--bg-color);
            scroll-behavior: smooth;
            height: calc(100vh - 280px);
            min-height: 300px;
        }

        .chat-container::-webkit-scrollbar {
            width: 6px;
        }

        .chat-container::-webkit-scrollbar-track {
            background: transparent;
        }

        .chat-container::-webkit-scrollbar-thumb {
            background: var(--secondary-color);
            border-radius: 3px;
        }

        .chat-container::-webkit-scrollbar-thumb:hover {
            background: var(--light-text);
        }

        .message {
            display: flex;
            margin-bottom: 0.5rem;
            animation: messageSlideIn 0.3s ease-out;
        }
        
        .typing-indicator {
            display: flex;
            margin-bottom: 0.5rem;
            animation: messageSlideIn 0.3s ease-out;
            justify-content: flex-start;
        }
        
        .typing-indicator .message-bubble {
            background: var(--ai-msg-bg);
            color: var(--text-color);
            border: 1px solid var(--border-color);
            border-bottom-left-radius: 0.375rem;
            padding: 0.5rem 1rem;
        }
        
        .typing-dots {
            display: flex;
            align-items: center;
            height: 1.5rem;
        }
        
        .typing-dot {
            display: inline-block;
            width: 0.5rem;
            height: 0.5rem;
            border-radius: 50%;
            background-color: var(--light-text);
            margin: 0 0.1rem;
            animation: typingAnimation 1.4s infinite ease-in-out;
        }
        
        .typing-dot:nth-child(1) {
            animation-delay: 0s;
        }
        
        .typing-dot:nth-child(2) {
            animation-delay: 0.2s;
        }
        
        .typing-dot:nth-child(3) {
            animation-delay: 0.4s;
        }
        
        @keyframes typingAnimation {
            0%, 60%, 100% {
                transform: translateY(0);
                opacity: 0.6;
            }
            30% {
                transform: translateY(-0.3rem);
                opacity: 1;
            }
        }

        @keyframes messageSlideIn {
            from {
                opacity: 0;
                transform: translateY(10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .message-bubble {
            max-width: 75%;
            padding: 0.875rem 1.125rem;
            border-radius: 1.125rem;
            position: relative;
            word-wrap: break-word;
            box-shadow: var(--shadow-sm);
        }

        .user-message {
            justify-content: flex-end;
        }

        .user-message .message-bubble {
            background: var(--user-msg-bg);
            color: white;
            border-bottom-right-radius: 0.375rem;
        }

        .ai-message {
            justify-content: flex-start;
        }

        .ai-message .message-bubble {
            background: var(--ai-msg-bg);
            color: var(--text-color);
            border: 1px solid var(--border-color);
            border-bottom-left-radius: 0.375rem;
        }

        .message-content {
            margin: 0;
            white-space: pre-wrap;
            font-size: 0.9rem;
            line-height: 1.5;
        }

        .message-time {
            font-size: 0.7rem;
            opacity: 0.7;
            margin-top: 0.25rem;
            text-align: right;
        }

        .ai-message .message-time {
            text-align: left;
        }

        .input-container {
            padding: 1rem;
            background: var(--chat-bg);
            border-top: 1px solid var(--border-color);
            box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.05);
            flex-shrink: 0;
            position: sticky;
            bottom: 0;
            z-index: 10;
        }

        .input-wrapper {
            display: flex;
            align-items: flex-end;
            gap: 0.75rem;
            max-width: 100%;
        }

        #user-input {
            flex: 1;
            padding: 0.875rem 1rem;
            border: 1px solid var(--border-color);
            border-radius: 1.25rem;
            font-size: 0.95rem;
            resize: none;
            min-height: 44px;
            max-height: 120px;
            background: var(--bg-color);
            transition: all 0.2s ease;
            font-family: inherit;
            line-height: 1.4;
        }

        #user-input:focus {
            outline: none;
            border-color: var(--primary-color);
            box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
            background: white;
        }

        #user-input::placeholder {
            color: var(--light-text);
        }

        .send-button {
            width: 44px;
            height: 44px;
            background: var(--primary-color);
            color: white;
            border: none;
            border-radius: 50%;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s ease;
            box-shadow: var(--shadow-md);
            flex-shrink: 0;
        }

        .send-button:hover:not(:disabled) {
            background: var(--primary-hover);
            transform: translateY(-1px);
            box-shadow: var(--shadow-lg);
        }

        .send-button:active {
            transform: translateY(0);
        }

        .send-button:disabled {
            background: var(--secondary-color);
            cursor: not-allowed;
            transform: none;
            box-shadow: var(--shadow-sm);
        }

        .send-icon {
            width: 20px;
            height: 20px;
            fill: currentColor;
        }

        .clear-chat {
            background: none;
            border: 1px solid var(--border-color);
            color: var(--light-text);
            padding: 0.5rem 0.875rem;
            border-radius: 0.5rem;
            cursor: pointer;
            font-size: 0.8rem;
            transition: all 0.2s ease;
            font-weight: 500;
        }

        .clear-chat:hover {
            background: var(--bg-color);
            border-color: var(--light-text);
            color: var(--text-color);
        }
        
        /* Modal styles */
        .modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: rgba(0, 0, 0, 0.5);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 1000;
        }
        
        .modal {
            background: var(--chat-bg);
            border-radius: 0.75rem;
            box-shadow: var(--shadow-lg);
            width: 90%;
            max-width: 600px;
            max-height: 80vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        
        .modal-header {
            padding: 1rem;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .modal-title {
            font-size: 1.25rem;
            font-weight: 600;
            color: var(--text-color);
            margin: 0;
        }
        
        .modal-close {
            background: none;
            border: none;
            font-size: 1.5rem;
            cursor: pointer;
            color: var(--light-text);
        }
        
        .modal-body {
            padding: 1rem;
            overflow-y: auto;
            flex: 1;
        }
        
        .modal-footer {
            padding: 1rem;
            border-top: 1px solid var(--border-color);
            display: flex;
            justify-content: flex-end;
            gap: 0.5rem;
        }
        
        .reference-form {
            display: flex;
            flex-direction: column;
            gap: 1rem;
            margin-bottom: 1.5rem;
        }
        
        .form-help {
            font-size: 0.75rem;
            color: var(--light-text);
            margin-top: 0.5rem;
            font-style: italic;
        }
        
        .form-group {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }
        
        .form-group label {
            font-size: 0.875rem;
            font-weight: 500;
            color: var(--text-color);
        }
        
        .form-control {
            padding: 0.75rem;
            border: 1px solid var(--border-color);
            border-radius: 0.5rem;
            font-size: 0.875rem;
            background: var(--bg-color);
            color: var(--text-color);
            font-family: inherit;
        }
        
        .form-control:focus {
            outline: none;
            border-color: var(--primary-color);
            box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
        }
        
        textarea.form-control {
            min-height: 100px;
            resize: vertical;
        }
        
        .form-actions {
            display: flex;
            gap: 0.5rem;
        }
        
        .btn {
            padding: 0.5rem 1rem;
            border-radius: 0.5rem;
            font-size: 0.875rem;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
        }
        
        .btn-primary {
            background: var(--primary-color);
            color: white;
            border: none;
        }
        
        .btn-primary:hover {
            background: var(--primary-hover);
        }
        
        .btn-secondary {
            background: var(--secondary-color);
            color: var(--text-color);
            border: none;
        }
        
        .btn-secondary:hover {
            background: var(--border-color);
        }
        
        .reference-list {
            margin-top: 1.5rem;
        }
        
        .reference-item {
            padding: 1rem;
            border: 1px solid var(--border-color);
            border-radius: 0.5rem;
            margin-bottom: 1rem;
            background: var(--bg-color);
        }
        
        .reference-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 0.5rem;
        }
        
        .reference-title {
            font-weight: 600;
            font-size: 1rem;
            color: var(--text-color);
            margin: 0;
        }
        
        .reference-actions {
            display: flex;
            gap: 0.5rem;
        }
        
        .reference-toggle {
            display: flex;
            align-items: center;
            gap: 0.25rem;
            font-size: 0.75rem;
            color: var(--light-text);
        }
        
        .reference-content {
            font-size: 0.875rem;
            color: var(--text-color);
            white-space: pre-wrap;
            margin-top: 0.5rem;
            padding-top: 0.5rem;
            border-top: 1px dashed var(--border-color);
            max-height: 150px;
            overflow-y: auto;
        }
        
        .reference-timestamp {
            font-size: 0.75rem;
            color: var(--light-text);
            margin-top: 0.5rem;
        }

        .system-message {
            text-align: center;
            color: var(--light-text);
            margin: 2rem 0;
            font-style: italic;
            font-size: 0.875rem;
            padding: 1rem;
            background: var(--chat-bg);
            border-radius: 0.75rem;
            border: 1px dashed var(--border-color);
        }

        .loading {
            display: inline-block;
            width: 18px;
            height: 18px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-top: 2px solid white;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .controls-container {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 1.5rem;
            margin: 0.75rem 0;
            flex-wrap: wrap;
        }

        .model-selector-container {
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .model-selector-container label {
            font-size: 0.8rem;
            color: var(--light-text);
            font-weight: 600;
            white-space: nowrap;
        }

        #model-selector {
            padding: 0.5rem 0.75rem;
            border: 1px solid var(--border-color);
            border-radius: 0.5rem;
            background: var(--bg-color);
            color: var(--text-color);
            font-size: 0.8rem;
            min-width: 140px;
            transition: all 0.2s ease;
            font-weight: 500;
        }

        #model-selector:focus {
            outline: none;
            border-color: var(--primary-color);
            box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
            background: white;
        }

        #model-selector:disabled {
            background: var(--secondary-color);
            cursor: not-allowed;
            opacity: 0.6;
        }

        .memory-toggle-container {
            display: flex;
            align-items: center;
        }

        .toggle-label {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            cursor: pointer;
            font-size: 0.8rem;
            color: var(--light-text);
            font-weight: 600;
            user-select: none;
        }

        .toggle-label input[type="checkbox"] {
            display: none;
        }

        .toggle-slider {
            position: relative;
            width: 44px;
            height: 24px;
            background: var(--secondary-color);
            border-radius: 12px;
            transition: all 0.3s ease;
            box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.1);
        }

        .toggle-slider::before {
            content: '';
            position: absolute;
            top: 2px;
            left: 2px;
            width: 20px;
            height: 20px;
            background: white;
            border-radius: 50%;
            transition: all 0.3s ease;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        }

        .toggle-label input[type="checkbox"]:checked + .toggle-slider {
            background: var(--primary-color);
        }

        .toggle-label input[type="checkbox"]:checked + .toggle-slider::before {
            transform: translateX(20px);
        }

        .toggle-text {
            white-space: nowrap;
        }

        /* Session info styles */
        .session-info {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
            margin-top: 0.5rem;
            padding: 0.5rem;
            background: var(--bg-color);
            border-radius: 0.5rem;
            border: 1px solid var(--border-color);
        }

        #current-session-title {
            font-size: 0.875rem;
            font-weight: 500;
            color: var(--text-color);
        }

        .edit-title-btn {
            background: none;
            border: none;
            cursor: pointer;
            font-size: 0.875rem;
            color: var(--light-text);
            padding: 0.25rem;
            border-radius: 0.25rem;
            transition: all 0.2s ease;
        }

        .edit-title-btn:hover {
            background: var(--secondary-color);
            color: var(--text-color);
        }

        /* Dashboard styles */
        .dashboard-modal {
            width: 95%;
            max-width: 800px;
            max-height: 85vh;
        }

        .session-list {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
            margin-top: 1rem;
        }

        .session-item {
            padding: 1rem;
            border: 1px solid var(--border-color);
            border-radius: 0.5rem;
            background: var(--bg-color);
            cursor: pointer;
            transition: all 0.2s ease;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .session-item:hover {
            background: var(--secondary-color);
            border-color: var(--primary-color);
        }

        .session-item.current {
            border-color: var(--primary-color);
            background: rgba(37, 99, 235, 0.1);
        }

        .session-details {
            flex: 1;
        }

        .session-title {
            font-weight: 600;
            font-size: 1rem;
            color: var(--text-color);
            margin: 0 0 0.25rem 0;
        }

        .session-meta {
            font-size: 0.75rem;
            color: var(--light-text);
            display: flex;
            gap: 1rem;
        }

        .session-actions {
            display: flex;
            gap: 0.5rem;
            align-items: center;
        }

        .session-delete {
            background: #dc2626;
            color: white;
            border: none;
            padding: 0.25rem 0.5rem;
            border-radius: 0.25rem;
            font-size: 0.75rem;
            cursor: pointer;
            transition: all 0.2s ease;
        }

        .session-delete:hover {
            background: #b91c1c;
        }

        .new-session-btn {
            background: var(--primary-color);
            color: white;
            border: none;
            padding: 0.75rem 1rem;
            border-radius: 0.5rem;
            font-size: 0.875rem;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
            margin-bottom: 1rem;
            width: 100%;
        }

        .new-session-btn:hover {
            background: var(--primary-hover);
        }

        .export-import-section {
            margin-top: 1rem;
            padding-top: 1rem;
            border-top: 1px solid var(--border-color);
        }

        .export-import-buttons {
            display: flex;
            gap: 0.5rem;
            margin-bottom: 1rem;
        }

        .export-btn, .import-btn {
            flex: 1;
            padding: 0.5rem 1rem;
            border: 1px solid var(--border-color);
            border-radius: 0.5rem;
            background: var(--bg-color);
            color: var(--text-color);
            cursor: pointer;
            font-size: 0.875rem;
            transition: all 0.2s ease;
        }

        .export-btn:hover, .import-btn:hover {
            background: var(--secondary-color);
            border-color: var(--primary-color);
        }

        .import-file-input {
            display: none;
        }

        /* Dashboard View Styles */
        .dashboard-view {
            flex: 1;
            padding: 2rem;
            overflow-y: auto;
            background: var(--bg-color);
        }

        .dashboard-content {
            max-width: 800px;
            margin: 0 auto;
        }

        .dashboard-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 2rem;
            padding-bottom: 1rem;
            border-bottom: 2px solid var(--border-color);
        }

        .dashboard-header h2 {
            margin: 0;
            color: var(--primary-color);
            font-size: 1.75rem;
            font-weight: 700;
        }

        .chat-view {
            flex: 1;
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }

        /* Update session list for main dashboard */
        .dashboard-view .session-list {
            margin-bottom: 2rem;
        }

        .dashboard-view .session-item {
            margin-bottom: 1rem;
            padding: 1.5rem;
            border-radius: 0.75rem;
            box-shadow: var(--shadow-md);
            transition: all 0.3s ease;
        }

        .dashboard-view .session-item:hover {
            transform: translateY(-2px);
            box-shadow: var(--shadow-lg);
        }

        .empty-state {
            text-align: center;
            padding: 3rem 1rem;
            color: var(--light-text);
        }

        .empty-state h3 {
            margin-bottom: 1rem;
            color: var(--text-color);
        }

        .empty-state p {
            margin-bottom: 2rem;
            font-size: 1.1rem;
        }

        /* Mobile Responsiveness */
        @media (max-width: 768px) {
            .container {
                height: 100vh;
                max-width: 100%;
                border-radius: 0;
            }

            header {
                padding: 0.75rem;
            }

            h1 {
                font-size: 1.25rem;
                margin-bottom: 0.5rem;
            }

            .controls-container {
                gap: 1rem;
                margin: 0.5rem 0;
            }

            .model-selector-container,
            .memory-toggle-container {
                flex: 1;
                min-width: 0;
            }

            #model-selector {
                min-width: 120px;
                font-size: 0.75rem;
            }

            .toggle-label {
                font-size: 0.75rem;
            }

            .status-indicator {
                font-size: 0.7rem;
                padding: 0.25rem;
            }

            .chat-container {
                padding: 0.75rem;
                gap: 0.5rem;
            }

            .message-bubble {
                max-width: 85%;
                padding: 0.75rem 1rem;
                font-size: 0.875rem;
            }

            .input-container {
                padding: 0.75rem;
            }

            .input-wrapper {
                gap: 0.5rem;
            }

            #user-input {
                font-size: 0.9rem;
                padding: 0.75rem;
            }

            .send-button {
                width: 40px;
                height: 40px;
            }

            .send-icon {
                width: 18px;
                height: 18px;
            }

            .clear-chat {
                padding: 0.4rem 0.6rem;
                font-size: 0.75rem;
            }
        }

        @media (max-width: 480px) {
            .controls-container {
                flex-direction: column;
                gap: 0.75rem;
                align-items: stretch;
            }

            .model-selector-container,
            .memory-toggle-container {
                justify-content: center;
            }

            #model-selector {
                min-width: 160px;
            }

            .message-bubble {
                max-width: 90%;
                padding: 0.625rem 0.875rem;
            }

            .chat-container {
                padding: 0.5rem;
            }

            .input-container {
                padding: 0.5rem;
            }
        }

        /* Dark mode support */
        @media (prefers-color-scheme: dark) {
            :root {
                --bg-color: #0f172a;
                --chat-bg: #1e293b;
                --text-color: #f1f5f9;
                --light-text: #94a3b8;
                --border-color: #334155;
                --ai-msg-bg: #334155;
                --secondary-color: #475569;
            }

            .status-connected {
                color: #10b981;
                background: rgba(16, 185, 129, 0.1);
            }

            .status-disconnected {
                color: #ef4444;
                background: rgba(239, 68, 68, 0.1);
            }

            #user-input:focus {
                background: var(--chat-bg);
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Local AI Assistant</h1>
            <div class="controls-container">
                <div class="model-selector-container">
                    <label for="model-selector">Model:</label>
                    <select id="model-selector" aria-label="Select AI model">
                        <option value="">Loading models...</option>
                    </select>
                </div>
                <div class="memory-toggle-container">
                    <label for="memory-toggle" class="toggle-label">
                        <input type="checkbox" id="memory-toggle" checked aria-label="Toggle conversation memory">
                        <span class="toggle-slider"></span>
                        <span class="toggle-text">Memory</span>
                    </label>
                </div>
                <button id="back-to-dashboard" class="clear-chat" aria-label="Back to dashboard" style="display: none;">
                    ← Dashboard
                </button>
                <button id="reference-btn" class="clear-chat" aria-label="Manage reference contexts">
                    References
                </button>
            </div>
            <div class="session-info" style="display: none;">
                <span id="current-session-title">New Chat</span>
                <button id="edit-session-title" class="edit-title-btn" aria-label="Edit session title">✏️</button>
            </div>
            <div id="status-indicator" class="status-indicator">Connecting...</div>
        </header>
        
        <!-- Dashboard View (Main Interface) -->
        <div id="dashboard-view" class="dashboard-view">
            <div class="dashboard-content">
                <div class="dashboard-header">
                    <h2>Your Conversations</h2>
                    <button id="new-session-btn" class="new-session-btn">+ Start New Chat</button>
                </div>
                
                <div id="session-list" class="session-list">
                    <!-- Session items will be added here dynamically -->
                </div>
                
                <div class="export-import-section">
                    <h4>Export/Import Sessions</h4>
                    <div class="export-import-buttons">
                        <button id="export-sessions-btn" class="export-btn">Export All Sessions</button>
                        <button id="import-sessions-btn" class="import-btn">Import Sessions</button>
                        <input type="file" id="import-file-input" class="import-file-input" accept=".json">
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Chat View (Secondary Interface) -->
        <div id="chat-view" class="chat-view" style="display: none;">
            <div id="chat-container" class="chat-container">
                <div class="system-message">Start a conversation with your local AI assistant</div>
            </div>
            
            <!-- Typing indicator (hidden by default) -->
            <div id="typing-indicator" class="typing-indicator" style="display: none;">
                <div class="message-bubble">
                    <div class="typing-dots">
                        <span class="typing-dot"></span>
                        <span class="typing-dot"></span>
                        <span class="typing-dot"></span>
                    </div>
                </div>
            </div>
            
            <div class="input-container">
                <div class="input-wrapper">
                    <textarea
                        id="user-input"
                        placeholder="Type your message here..."
                        rows="1"
                        aria-label="Message input"></textarea>
                    <button id="send-button" class="send-button" aria-label="Send message">
                        <svg class="send-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="22" y1="2" x2="11" y2="13"></line>
                            <polygon points="22,2 15,22 11,13 2,9"></polygon>
                        </svg>
                    </button>
                    <button id="clear-chat" class="clear-chat" aria-label="Clear chat">Clear</button>
                </div>
            </div>
        </div>
        
        <!-- Reference Context Modal -->
        <div id="reference-modal" class="modal-overlay">
            <div class="modal">
                <div class="modal-header">
                    <h3 class="modal-title">Manage Reference Contexts</h3>
                    <button class="modal-close" id="modal-close">&times;</button>
                </div>
                <div class="modal-body">
                    <form id="reference-form" class="reference-form">
                        <input type="hidden" id="reference-id" value="">
                        <div class="form-group">
                            <label for="reference-title">Title</label>
                            <input type="text" id="reference-title" class="form-control" placeholder="E.g., Company Information, Product Specs, etc.">
                        </div>
                        <div class="form-group">
                            <label for="reference-content">Content</label>
                            <textarea id="reference-content" class="form-control" placeholder="Enter the reference information that the AI should use..."></textarea>
                        </div>
                        <div class="form-actions">
                            <button type="submit" id="reference-submit" class="btn btn-primary">Add Reference</button>
                            <button type="button" id="reference-cancel" class="btn btn-secondary" style="display: none;">Cancel Edit</button>
                        </div>
                        <div class="form-help">References are saved to the database and will be available even after closing the modal.</div>
                    </form>
                    
                    <div id="reference-list" class="reference-list">
                        <!-- Reference items will be added here dynamically -->
                    </div>
                </div>
                <div class="modal-footer">
                    <button id="modal-close-btn" class="btn btn-secondary">Close</button>
                </div>
            </div>
        </div>
    </div>
    
    <script>
        // DOM Elements
        const chatContainer = document.getElementById('chat-container');
        const userInput = document.getElementById('user-input');
        const sendButton = document.getElementById('send-button');
        const clearButton = document.getElementById('clear-chat');
        const statusIndicator = document.getElementById('status-indicator');
        const modelSelector = document.getElementById('model-selector');
        const memoryToggle = document.getElementById('memory-toggle');
        const typingIndicator = document.getElementById('typing-indicator');
        const referenceBtn = document.getElementById('reference-btn');
        const referenceModal = document.getElementById('reference-modal');
        const modalClose = document.getElementById('modal-close');
        const modalCloseBtn = document.getElementById('modal-close-btn');
        const referenceForm = document.getElementById('reference-form');
        const referenceId = document.getElementById('reference-id');
        const referenceTitle = document.getElementById('reference-title');
        const referenceContent = document.getElementById('reference-content');
        const referenceList = document.getElementById('reference-list');
        const referenceSubmit = document.getElementById('reference-submit');
        const referenceCancel = document.getElementById('reference-cancel');
        
        // Dashboard elements
        const backToDashboard = document.getElementById('back-to-dashboard');
        const dashboardView = document.getElementById('dashboard-view');
        const chatView = document.getElementById('chat-view');
        const newSessionBtn = document.getElementById('new-session-btn');
        const sessionList = document.getElementById('session-list');
        const currentSessionTitle = document.getElementById('current-session-title');
        const editSessionTitle = document.getElementById('edit-session-title');
        const exportSessionsBtn = document.getElementById('export-sessions-btn');
        const importSessionsBtn = document.getElementById('import-sessions-btn');
        const importFileInput = document.getElementById('import-file-input');
        const sessionInfo = document.querySelector('.session-info');

        // References will be session-specific (no fixed session ID needed)
        
        // Session management
        let sessionId = localStorage.getItem('sessionId');
        if (!sessionId) {
            sessionId = generateSessionId();
            console.log("Generated new session ID:", sessionId);
        } else {
            console.log("Using existing session ID from localStorage:", sessionId);
        }
        let messageHistory = JSON.parse(localStorage.getItem('messageHistory_' + sessionId) || '[]');
        let selectedModel = localStorage.getItem('selectedModel') || '';
        let memoryEnabled = localStorage.getItem('memoryEnabled') !== 'false'; // Default to true

        // Initialize chat with stored messages
        function initChat() {
            // Show dashboard by default
            showDashboard();
            
            // Load session list
            loadSessionList();
            
            // Ensure session ID is saved to localStorage
            localStorage.setItem('sessionId', sessionId);
            console.log("Session ID saved to localStorage:", sessionId);
            
            // If there's an existing session with messages, we can optionally load it
            // But keep dashboard as the main interface
            if (messageHistory.length > 0) {
                console.log("Found existing message history for session:", sessionId);
                // The user can click on the session in the dashboard to continue
            }
            
            // Auto-resize textarea
            userInput.addEventListener('input', function() {
                this.style.height = 'auto';
                this.style.height = (this.scrollHeight) + 'px';
            });
            
            // Send message on Enter (but allow Shift+Enter for new lines)
            userInput.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                }
            });
            
            // Send button click handler
            sendButton.addEventListener('click', sendMessage);
            
            // Clear chat button handler
            clearButton.addEventListener('click', clearChat);
            
            // Model selector change handler
            modelSelector.addEventListener('change', async function() {
                const previousModel = selectedModel;
                const newModel = this.value;
                
                // Show loading state
                statusIndicator.textContent = 'Checking if Ollama is running...';
                statusIndicator.className = 'status-indicator';
                
                try {
                    // First check if Ollama is running
                    const statusResponse = await fetch('/api/status');
                    if (!statusResponse.ok) {
                        throw new Error("Ollama is not running");
                    }
                    
                    const statusData = await statusResponse.json();
                    if (statusData.status !== "connected") {
                        throw new Error("Ollama is not connected");
                    }
                    
                    // Now check if the model exists
                    statusIndicator.textContent = 'Checking if model ' + newModel + ' is available...';
                    
                    const modelsResponse = await fetch('/api/models');
                    if (!modelsResponse.ok) {
                        throw new Error("Failed to fetch models");
                    }
                    
                    const modelsData = await modelsResponse.json();
                    const modelExists = modelsData.models.some(m => m.name === newModel);
                    
                    if (!modelExists) {
                        showTemporaryMessage('Warning: Model ' + newModel + ' may not be installed. If you encounter errors, run "ollama pull ' + newModel + '" to download it.');
                    }
                    
                    // Update the selected model
                    selectedModel = newModel;
                    localStorage.setItem('selectedModel', selectedModel);
                    updateStatusIndicator();
                    showTemporaryMessage('Switched to model: ' + selectedModel);
                    
                } catch (error) {
                    console.error("Error switching models:", error);
                    
                    // Show a more helpful error message
                    if (error.message.includes("not running") || error.message.includes("not connected")) {
                        showTemporaryMessage('Ollama is not running. Please start Ollama and try again.');
                    } else {
                        showTemporaryMessage('Failed to switch to ' + newModel + '. ' + error.message);
                    }
                    
                    // Revert to previous model
                    this.value = previousModel;
                    selectedModel = previousModel;
                    localStorage.setItem('selectedModel', previousModel);
                    updateStatusIndicator();
                }
            });
            
            // Memory toggle change handler
            memoryToggle.addEventListener('change', function() {
                memoryEnabled = this.checked;
                localStorage.setItem('memoryEnabled', memoryEnabled);
                updateStatusIndicator();
                
                // Show feedback to user
                const feedbackMsg = memoryEnabled ?
                    'Memory enabled - AI will remember conversation context' :
                    'Memory disabled - Each message will be independent';
                showTemporaryMessage(feedbackMsg);
            });
            
            // Set initial memory toggle state
            memoryToggle.checked = memoryEnabled;
            
            // Load available models
            loadAvailableModels();
            
            // Check connection status
            checkConnectionStatus();
            
            // Load reference contexts when the application starts
            loadReferenceContexts();
            console.log("Initial session ID:", sessionId);
            
            // Reference button click handler
            referenceBtn.addEventListener('click', function() {
                console.log("Opening reference modal with session ID:", sessionId);
                referenceModal.style.display = 'flex';
                loadReferenceContexts(); // Reload references when modal is opened
            });
            
            // Modal close handlers
            modalClose.addEventListener('click', function() {
                referenceModal.style.display = 'none';
            });
            
            modalCloseBtn.addEventListener('click', function() {
                referenceModal.style.display = 'none';
            });
            
            // Close modal when clicking outside
            referenceModal.addEventListener('click', function(e) {
                if (e.target === referenceModal) {
                    referenceModal.style.display = 'none';
                }
            });
            
            // Reference form submit handler
            referenceForm.addEventListener('submit', function(e) {
                e.preventDefault();
                
                const title = referenceTitle.value.trim();
                const content = referenceContent.value.trim();
                const id = referenceId.value;
                
                if (!title || !content) {
                    alert('Please enter both title and content for the reference.');
                    return;
                }
                
                if (id) {
                    // Update existing reference
                    updateReferenceContextUI(id, title, content);
                } else {
                    // Add new reference context
                    addReferenceContextUI(title, content);
                }
                
                // Clear form
                resetReferenceForm();
            });
            
            // Reference cancel button handler
            referenceCancel.addEventListener('click', function() {
                resetReferenceForm();
            });
            
            // Back to dashboard button handler
            backToDashboard.addEventListener('click', function() {
                showDashboard();
            });
            
            // New session button handler
            newSessionBtn.addEventListener('click', function() {
                createNewSession();
            });
            
            // Edit session title handler
            editSessionTitle.addEventListener('click', function() {
                editCurrentSessionTitle();
            });
            
            // Export sessions button handler
            exportSessionsBtn.addEventListener('click', function() {
                exportAllSessions();
            });
            
            // Import sessions button handler
            importSessionsBtn.addEventListener('click', function() {
                importFileInput.click();
            });
            
            // Import file input handler
            importFileInput.addEventListener('change', function(e) {
                const file = e.target.files[0];
                if (file) {
                    importSessions(file);
                }
            });
            
            // Load current session title
            loadCurrentSessionTitle();
        }

        // View Switching Functions
        
        // Show dashboard view
        function showDashboard() {
            dashboardView.style.display = 'block';
            chatView.style.display = 'none';
            backToDashboard.style.display = 'none';
            sessionInfo.style.display = 'none';
            referenceBtn.style.display = 'none';
            loadSessionList();
        }
        
        // Show chat view
        function showChat() {
            dashboardView.style.display = 'none';
            chatView.style.display = 'flex';
            backToDashboard.style.display = 'inline-block';
            sessionInfo.style.display = 'flex';
            referenceBtn.style.display = 'inline-block';
        }

        // Generate a random session ID
        function generateSessionId() {
            return 'session_' + Math.random().toString(36).substring(2, 15);
        }

        // Add a message to the UI
        function addMessageToUI(role, content) {
            const messageDiv = document.createElement('div');
            messageDiv.classList.add('message');
            messageDiv.classList.add(role === 'user' ? 'user-message' : 'ai-message');
            
            const messageBubble = document.createElement('div');
            messageBubble.classList.add('message-bubble');
            
            const messageContent = document.createElement('p');
            messageContent.classList.add('message-content');
            messageContent.textContent = content;
            
            messageBubble.appendChild(messageContent);
            messageDiv.appendChild(messageBubble);
            chatContainer.appendChild(messageDiv);
            
            // Scroll to bottom
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }
        
        // Show typing indicator
        function showTypingIndicator() {
            // Make typing indicator visible
            typingIndicator.style.display = 'flex';
            
            // Append to chat container
            chatContainer.appendChild(typingIndicator);
            
            // Scroll to bottom
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }
        
        // Hide typing indicator
        function hideTypingIndicator() {
            typingIndicator.style.display = 'none';
        }

        // Save message to history
        function saveMessage(role, content) {
            messageHistory.push({ role, content });
            localStorage.setItem('messageHistory_' + sessionId, JSON.stringify(messageHistory));
        }

        // Clear chat history
        function clearChat() {
            if (confirm('Are you sure you want to clear the chat history?')) {
                messageHistory = [];
                localStorage.removeItem('messageHistory_' + sessionId);
                // Keep the same session ID to maintain references
                // but clear the messages
                console.log("Cleared chat history for session ID:", sessionId);
                chatContainer.innerHTML = '<div class="system-message">Start a conversation with your local AI assistant</div>';
            }
        }

        // Load available models
        async function loadAvailableModels() {
            try {
                const response = await fetch('/api/models');
                if (response.ok) {
                    const data = await response.json();
                    const models = data.models;
                    
                    // Clear existing options
                    modelSelector.innerHTML = '';
                    
                    if (models.length === 0) {
                        modelSelector.innerHTML = '<option value="">No models available</option>';
                        modelSelector.disabled = true;
                        return;
                    }
                    
                    // Add model options
                    models.forEach(model => {
                        const option = document.createElement('option');
                        option.value = model.name;
                        option.textContent = \`\${model.name} (\${formatModelSize(model.size)})\`;
                        modelSelector.appendChild(option);
                    });
                    
                    // Set selected model
                    if (selectedModel && models.find(m => m.name === selectedModel)) {
                        modelSelector.value = selectedModel;
                    } else if (models.length > 0) {
                        // Select first available model if no previous selection
                        selectedModel = models[0].name;
                        modelSelector.value = selectedModel;
                        localStorage.setItem('selectedModel', selectedModel);
                    }
                    
                    modelSelector.disabled = false;
                    updateStatusIndicator();
                } else {
                    modelSelector.innerHTML = '<option value="">Failed to load models</option>';
                    modelSelector.disabled = true;
                }
            } catch (error) {
                console.error('Error loading models:', error);
                modelSelector.innerHTML = '<option value="">Error loading models</option>';
                modelSelector.disabled = true;
            }
        }
        
        // Format model size for display
        function formatModelSize(bytes) {
            if (!bytes) return 'Unknown size';
            const gb = bytes / (1024 * 1024 * 1024);
            return gb >= 1 ? \`\${gb.toFixed(1)}GB\` : \`\${(bytes / (1024 * 1024)).toFixed(0)}MB\`;
        }
        
        // Show temporary message to user
        function showTemporaryMessage(message) {
            const tempDiv = document.createElement('div');
            tempDiv.className = 'system-message';
            tempDiv.textContent = message;
            tempDiv.style.backgroundColor = '#e0f2fe';
            tempDiv.style.border = '1px solid #0284c7';
            tempDiv.style.borderRadius = '0.25rem';
            tempDiv.style.padding = '0.5rem';
            tempDiv.style.margin = '0.5rem 0';
            
            chatContainer.appendChild(tempDiv);
            chatContainer.scrollTop = chatContainer.scrollHeight;
            
            // Remove after 3 seconds
            setTimeout(() => {
                if (tempDiv.parentNode) {
                    tempDiv.parentNode.removeChild(tempDiv);
                }
            }, 3000);
        }

        // Update status indicator with model info
        function updateStatusIndicator() {
            if (selectedModel) {
                const memoryStatus = memoryEnabled ? 'Memory ON' : 'Memory OFF';
                statusIndicator.textContent = \`Connected to Ollama - Using \${selectedModel} (\${memoryStatus})\`;
                statusIndicator.className = 'status-indicator status-connected';
            } else {
                checkConnectionStatus();
            }
        }

        // Check connection status
        async function checkConnectionStatus() {
            try {
                const response = await fetch('/api/status');
                if (response.ok) {
                    if (selectedModel) {
                        const memoryStatus = memoryEnabled ? 'Memory ON' : 'Memory OFF';
                        statusIndicator.textContent = \`Connected to Ollama - Using \${selectedModel} (\${memoryStatus})\`;
                    } else {
                        statusIndicator.textContent = 'Connected to Ollama - Select a model';
                    }
                    statusIndicator.className = 'status-indicator status-connected';
                } else {
                    statusIndicator.textContent = 'Ollama service unavailable';
                    statusIndicator.className = 'status-indicator status-disconnected';
                }
            } catch (error) {
                statusIndicator.textContent = 'Connection error';
                statusIndicator.className = 'status-indicator status-disconnected';
            }
        }

        // Send message to server
        async function sendMessage() {
            const message = userInput.value.trim();
            if (!message) return;
            
            if (!selectedModel) {
                addMessageToUI('ai', 'Please select a model first.');
                return;
            }
            
            // Disable input while processing
            userInput.disabled = true;
            sendButton.disabled = true;
            sendButton.innerHTML = '<div class="loading"></div>';
            
            // Add user message to UI and history
            addMessageToUI('user', message);
            saveMessage('user', message);
            
            // Clear input
            userInput.value = '';
            userInput.style.height = 'auto';
            
            // Show typing indicator
            showTypingIndicator();
            
            try {
                // Send request to server
                const response = await fetch('/api/chat', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        message,
                        sessionId,
                        model: selectedModel,
                        memoryEnabled: memoryEnabled
                    })
                });
                
                if (!response.ok) {
                    throw new Error('Server error: ' + response.status);
                }
                
                const data = await response.json();
                
                // Hide typing indicator
                hideTypingIndicator();
                
                // Add AI response to UI and history
                addMessageToUI('ai', data.response);
                saveMessage('ai', data.response);
            } catch (error) {
                console.error('Error:', error);
                
                // Hide typing indicator
                hideTypingIndicator();
                
                addMessageToUI('ai', 'Sorry, there was an error processing your request. Please make sure Ollama is running and the selected model is available.');
            } finally {
                // Re-enable input
                userInput.disabled = false;
                sendButton.disabled = false;
                sendButton.textContent = 'Send';
                userInput.focus();
            }
        }

        // Initialize the chat interface
        initChat();
        
        // Load reference contexts from server
        async function loadReferenceContexts() {
            try {
                // Use current session ID for references
                console.log("Loading reference contexts for current session ID:", sessionId);
                
                const response = await fetch('/api/reference?sessionId=' + sessionId);
                console.log("Response status:", response.status);
                
                if (!response.ok) {
                    throw new Error('Server error: ' + response.status);
                }
                
                const responseText = await response.text();
                console.log("Raw response text:", responseText);
                
                const contexts = JSON.parse(responseText);
                
                // Clear reference list
                referenceList.innerHTML = '';
                
                console.log("Loaded reference contexts:", contexts);
                console.log("Type of contexts:", typeof contexts);
                console.log("Is array:", Array.isArray(contexts));
                console.log("Number of references loaded:", contexts.length);
                
                // Add reference items
                if (Array.isArray(contexts)) {
                    contexts.forEach(ctx => {
                        console.log("Creating reference item:", ctx);
                        createReferenceItem(ctx.id, ctx.title, ctx.content, ctx.timestamp, ctx.is_active === 1);
                    });
                    
                    // If no references found, show a message
                    if (contexts.length === 0) {
                        referenceList.innerHTML = '<div class="system-message">No references found. Add your first reference above.</div>';
                    }
                } else {
                    console.error("Contexts is not an array:", contexts);
                    referenceList.innerHTML = '<div class="system-message">Invalid data format received from server.</div>';
                }
            } catch (error) {
                console.error('Error loading reference contexts:', error);
                // Show error message in reference list
                referenceList.innerHTML = '<div class="system-message">Failed to load reference contexts. Please try again.</div>';
            }
        }
        
        // Add reference context to UI and database
        async function addReferenceContextUI(title, content) {
            try {
                console.log("Adding reference for current session ID:", sessionId);
                console.log("Title:", title);
                console.log("Content:", content);
                
                // Send request to server using current session ID
                const response = await fetch('/api/reference', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        sessionId: sessionId,
                        title,
                        content
                    })
                });
                
                if (!response.ok) {
                    throw new Error('Server error: ' + response.status);
                }
                
                const data = await response.json();
                console.log("Added reference context:", data, "for session:", sessionId);
                
                // Create reference item
                createReferenceItem(data.id, title, content, data.timestamp, true);
                
                // Show feedback
                showTemporaryMessage('Reference context added successfully');
                
                // Immediately reload references to verify they're being saved
                await loadReferenceContexts();
            } catch (error) {
                console.error('Error adding reference context:', error);
                alert('Failed to add reference context. Please try again.');
            }
        }
        
        // Create reference item element
        function createReferenceItem(id, title, content, timestamp, isActive) {
            const item = document.createElement('div');
            item.className = 'reference-item';
            item.dataset.id = id;
            
            const date = new Date(timestamp);
            const formattedDate = date.toLocaleString();
            
            // Create elements instead of using innerHTML to avoid template literal issues
            const header = document.createElement('div');
            header.className = 'reference-header';
            
            const titleEl = document.createElement('h4');
            titleEl.className = 'reference-title';
            titleEl.textContent = title;
            
            const actions = document.createElement('div');
            actions.className = 'reference-actions';
            
            const toggleLabel = document.createElement('label');
            toggleLabel.className = 'reference-toggle';
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'reference-active';
            checkbox.checked = isActive;
            
            const toggleText = document.createElement('span');
            toggleText.textContent = 'Active';
            
            const editBtn = document.createElement('button');
            editBtn.className = 'btn btn-primary reference-edit';
            editBtn.textContent = 'Edit';
            
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn btn-secondary reference-delete';
            deleteBtn.textContent = 'Delete';
            
            const contentEl = document.createElement('div');
            contentEl.className = 'reference-content';
            contentEl.textContent = content;
            
            const timestampEl = document.createElement('div');
            timestampEl.className = 'reference-timestamp';
            timestampEl.textContent = 'Added: ' + formattedDate;
            
            // Assemble the elements
            toggleLabel.appendChild(checkbox);
            toggleLabel.appendChild(toggleText);
            
            actions.appendChild(toggleLabel);
            actions.appendChild(editBtn);
            actions.appendChild(deleteBtn);
            
            header.appendChild(titleEl);
            header.appendChild(actions);
            
            item.appendChild(header);
            item.appendChild(contentEl);
            item.appendChild(timestampEl);
            
            // Add event listeners
            const toggleCheckbox = item.querySelector('.reference-active');
            toggleCheckbox.addEventListener('change', async function() {
                try {
                    // Send request to server with current session ID
                    const response = await fetch('/api/reference/toggle', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            id,
                            isActive: this.checked,
                            sessionId: sessionId
                        })
                    });
                    
                    if (!response.ok) {
                        throw new Error('Server error: ' + response.status);
                    }
                    
                    // Show feedback
                    const status = this.checked ? 'activated' : 'deactivated';
                    showTemporaryMessage('Reference context ' + status);
                } catch (error) {
                    console.error('Error toggling reference context:', error);
                    alert('Failed to update reference context. Please try again.');
                    this.checked = !this.checked; // Revert checkbox state
                }
            });
            
            // Edit button handler
            const editButton = item.querySelector('.reference-edit');
            editButton.addEventListener('click', function() {
                // Populate form with reference data
                referenceId.value = id;
                referenceTitle.value = title;
                referenceContent.value = content;
                referenceSubmit.textContent = 'Update Reference';
                referenceCancel.style.display = 'inline-block';
                
                // Scroll to form
                referenceForm.scrollIntoView({ behavior: 'smooth' });
            });
            
            const deleteButton = item.querySelector('.reference-delete');
            deleteButton.addEventListener('click', async function() {
                if (confirm('Are you sure you want to delete this reference context?')) {
                    try {
                        // Send request to server with current session ID
                        const response = await fetch('/api/reference/delete', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                id,
                                sessionId: sessionId
                            })
                        });
                        
                        if (!response.ok) {
                            throw new Error('Server error: ' + response.status);
                        }
                        
                        // Remove item from UI
                        item.remove();
                        
                        // Show feedback
                        showTemporaryMessage('Reference context deleted');
                        
                        // Reload references to ensure UI is in sync with database
                        loadReferenceContexts();
                    } catch (error) {
                        console.error('Error deleting reference context:', error);
                        alert('Failed to delete reference context. Please try again.');
                    }
                }
            });
            
            // Add to reference list
            referenceList.appendChild(item);
            
            return item;
        }
        
        // Reset reference form
        function resetReferenceForm() {
            referenceId.value = '';
            referenceTitle.value = '';
            referenceContent.value = '';
            referenceSubmit.textContent = 'Add Reference';
            referenceCancel.style.display = 'none';
        }
        
        // Update reference context in UI and database
        async function updateReferenceContextUI(id, title, content) {
            try {
                // Send request to server
                const response = await fetch('/api/reference/update', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        id,
                        title,
                        content,
                        sessionId: sessionId // Add current session ID
                    })
                });
                
                if (!response.ok) {
                    throw new Error('Server error: ' + response.status);
                }
                
                // Update item in UI
                const item = document.querySelector('.reference-item[data-id="' + id + '"]');
                if (item) {
                    const titleEl = item.querySelector('.reference-title');
                    const contentEl = item.querySelector('.reference-content');
                    
                    if (titleEl) titleEl.textContent = title;
                    if (contentEl) contentEl.textContent = content;
                }
                
                // Show feedback
                showTemporaryMessage('Reference context updated successfully');
                
                // Reload references to ensure UI is in sync with database
                loadReferenceContexts();
            } catch (error) {
                console.error('Error updating reference context:', error);
                alert('Failed to update reference context. Please try again.');
            }
        }
        
        // Session Dashboard Functions
        
        // Load current session title
        async function loadCurrentSessionTitle() {
            try {
                const response = await fetch('/api/sessions/' + sessionId);
                if (response.ok) {
                    const sessionData = await response.json();
                    currentSessionTitle.textContent = sessionData.title || 'New Chat';
                } else {
                    currentSessionTitle.textContent = 'New Chat';
                }
            } catch (error) {
                console.error('Error loading session title:', error);
                currentSessionTitle.textContent = 'New Chat';
            }
        }
        
        // Load session list for dashboard
        async function loadSessionList() {
            try {
                const response = await fetch('/api/sessions');
                if (!response.ok) {
                    throw new Error('Failed to load sessions');
                }
                
                const sessions = await response.json();
                sessionList.innerHTML = '';
                
                if (sessions.length === 0) {
                    sessionList.innerHTML = '<div class="system-message">No saved sessions found. Start a new chat to create your first session.</div>';
                    return;
                }
                
                sessions.forEach(session => {
                    createSessionItem(session);
                });
            } catch (error) {
                console.error('Error loading sessions:', error);
                sessionList.innerHTML = '<div class="system-message">Failed to load sessions. Please try again.</div>';
            }
        }
        
        // Create session item element
        function createSessionItem(session) {
            const item = document.createElement('div');
            item.className = 'session-item';
            if (session.id === sessionId) {
                item.classList.add('current');
            }
            
            const details = document.createElement('div');
            details.className = 'session-details';
            
            const title = document.createElement('h4');
            title.className = 'session-title';
            title.textContent = session.title || 'New Chat';
            
            const meta = document.createElement('div');
            meta.className = 'session-meta';
            
            const createdDate = new Date(session.created_at).toLocaleDateString();
            const lastActivity = new Date(session.last_activity).toLocaleDateString();
            const messageCount = session.message_count || 0;
            
            meta.innerHTML =
                '<span>Created: ' + createdDate + '</span>' +
                '<span>Last activity: ' + lastActivity + '</span>' +
                '<span>Messages: ' + messageCount + '</span>';
            
            details.appendChild(title);
            details.appendChild(meta);
            
            const actions = document.createElement('div');
            actions.className = 'session-actions';
            
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'session-delete';
            deleteBtn.textContent = 'Delete';
            deleteBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                deleteSessionConfirm(session.id, session.title);
            });
            
            actions.appendChild(deleteBtn);
            
            item.appendChild(details);
            item.appendChild(actions);
            
            // Click to switch session
            item.addEventListener('click', function() {
                if (session.id !== sessionId) {
                    switchToSession(session.id, session.title);
                } else {
                    // If clicking on current session, just show chat view
                    showChat();
                }
            });
            
            sessionList.appendChild(item);
        }
        
        // Create new session
        async function createNewSession() {
            try {
                const newSessionId = generateSessionId();
                const title = 'New Chat';
                
                const response = await fetch('/api/sessions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        sessionId: newSessionId,
                        title: title
                    })
                });
                
                if (!response.ok) {
                    throw new Error('Failed to create session');
                }
                
                // Switch to new session and show chat view
                switchToSession(newSessionId, title);
                showChat();
                
                showTemporaryMessage('New chat session created');
            } catch (error) {
                console.error('Error creating new session:', error);
                alert('Failed to create new session. Please try again.');
            }
        }
        
        // Switch to a different session
        function switchToSession(newSessionId, title) {
            // Save current session ID
            sessionId = newSessionId;
            localStorage.setItem('sessionId', sessionId);
            
            // Clear current chat
            chatContainer.innerHTML = '<div class="system-message">Loading session...</div>';
            messageHistory = [];
            
            // Update UI
            currentSessionTitle.textContent = title || 'New Chat';
            
            // Show chat view first to ensure input box is visible
            showChat();
            
            // Load session messages
            loadSessionMessages(newSessionId);
            
            console.log('Switched to session:', newSessionId);
        }
        
        // Load messages for a session
        async function loadSessionMessages(sessionId) {
            try {
                console.log('Loading messages for session:', sessionId);
                const response = await fetch('/api/history?sessionId=' + sessionId);
                if (response.ok) {
                    const data = await response.json();
                    const history = data.history || [];
                    
                    console.log('Loaded message history:', history);
                    
                    // Clear current chat
                    chatContainer.innerHTML = '';
                    messageHistory = [];
                    
                    if (history.length === 0) {
                        chatContainer.innerHTML = '<div class="system-message">Start a conversation with your local AI assistant</div>';
                        console.log('No messages found for session:', sessionId);
                    } else {
                        console.log('Displaying', history.length, 'messages');
                        history.forEach(message => {
                            addMessageToUI(message.role, message.content);
                            messageHistory.push({ role: message.role, content: message.content });
                        });
                        
                        // Scroll to bottom to show latest messages
                        chatContainer.scrollTop = chatContainer.scrollHeight;
                    }
                    
                    // Update localStorage for the current session
                    localStorage.setItem('messageHistory_' + sessionId, JSON.stringify(messageHistory));
                    console.log('Session messages loaded successfully');
                } else {
                    console.error('Failed to load session history, status:', response.status);
                    chatContainer.innerHTML = '<div class="system-message">Failed to load session. Start a conversation with your local AI assistant</div>';
                }
            } catch (error) {
                console.error('Error loading session messages:', error);
                chatContainer.innerHTML = '<div class="system-message">Error loading session. Start a conversation with your local AI assistant</div>';
            }
        }
        
        // Delete session with confirmation
        function deleteSessionConfirm(sessionIdToDelete, title) {
            if (confirm('Are you sure you want to delete the session "' + title + '"? This action cannot be undone.')) {
                deleteSessionById(sessionIdToDelete);
            }
        }
        
        // Delete session by ID
        async function deleteSessionById(sessionIdToDelete) {
            try {
                const response = await fetch('/api/sessions/' + sessionIdToDelete, {
                    method: 'DELETE'
                });
                
                if (!response.ok) {
                    throw new Error('Failed to delete session');
                }
                
                // If we're deleting the current session, create a new one
                if (sessionIdToDelete === sessionId) {
                    const newSessionId = generateSessionId();
                    sessionId = newSessionId;
                    localStorage.setItem('sessionId', sessionId);
                    
                    // Clear chat
                    chatContainer.innerHTML = '<div class="system-message">Start a conversation with your local AI assistant</div>';
                    messageHistory = [];
                    localStorage.removeItem('messageHistory_' + sessionIdToDelete);
                    
                    currentSessionTitle.textContent = 'New Chat';
                }
                
                // Reload session list
                loadSessionList();
                showTemporaryMessage('Session deleted successfully');
                
            } catch (error) {
                console.error('Error deleting session:', error);
                alert('Failed to delete session. Please try again.');
            }
        }
        
        // Edit current session title
        function editCurrentSessionTitle() {
            const newTitle = prompt('Enter new session title:', currentSessionTitle.textContent);
            if (newTitle && newTitle.trim() !== '') {
                updateSessionTitle(sessionId, newTitle.trim());
            }
        }
        
        // Update session title
        async function updateSessionTitle(sessionId, newTitle) {
            try {
                const response = await fetch('/api/sessions/' + sessionId, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        title: newTitle
                    })
                });
                
                if (!response.ok) {
                    throw new Error('Failed to update session title');
                }
                
                currentSessionTitle.textContent = newTitle;
                showTemporaryMessage('Session title updated');
                
            } catch (error) {
                console.error('Error updating session title:', error);
                alert('Failed to update session title. Please try again.');
            }
        }
        
        // Export all sessions
        async function exportAllSessions() {
            try {
                const response = await fetch('/api/sessions/export');
                if (!response.ok) {
                    throw new Error('Failed to export sessions');
                }
                
                const exportData = await response.json();
                
                // Create download link
                const dataStr = JSON.stringify(exportData, null, 2);
                const dataBlob = new Blob([dataStr], { type: 'application/json' });
                const url = URL.createObjectURL(dataBlob);
                
                const link = document.createElement('a');
                link.href = url;
                link.download = 'ai-assistant-sessions-' + new Date().toISOString().split('T')[0] + '.json';
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(url);
                
                showTemporaryMessage('Sessions exported successfully');
            } catch (error) {
                console.error('Error exporting sessions:', error);
                alert('Failed to export sessions. Please try again.');
            }
        }
        
        // Import sessions from file
        async function importSessions(file) {
            try {
                const text = await file.text();
                const importData = JSON.parse(text);
                
                // Validate import data structure
                if (!importData.sessions || !Array.isArray(importData.sessions)) {
                    throw new Error('Invalid import file format');
                }
                
                const response = await fetch('/api/sessions/import', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(importData)
                });
                
                if (!response.ok) {
                    throw new Error('Failed to import sessions');
                }
                
                const result = await response.json();
                
                // Reload session list
                loadSessionList();
                
                showTemporaryMessage('Sessions imported successfully: ' + result.imported + ' sessions');
                
                // Reset file input
                importFileInput.value = '';
                
            } catch (error) {
                console.error('Error importing sessions:', error);
                alert('Failed to import sessions. Please check the file format and try again.');
                importFileInput.value = '';
            }
        }
        
        // Check connection status every 30 seconds
        setInterval(checkConnectionStatus, 30000);
    </script>
</body>
</html>`;

// HTTP Server
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    
    // Route for serving the web interface
    if (url.pathname === "/" && req.method === "GET") {
      return new Response(htmlTemplate, {
        headers: { "Content-Type": "text/html" }
      });
    }
    
    // API route for fetching available models
    if (url.pathname === "/api/models" && req.method === "GET") {
      try {
        const models = await getAvailableModels();
        return new Response(JSON.stringify({ models }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        console.error("Error fetching models:", error);
        return new Response(JSON.stringify({ error: "Failed to fetch models", models: [] }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
    
    // API route for checking status
    if (url.pathname === "/api/status" && req.method === "GET") {
      try {
        const response = await fetch(`${OLLAMA_API_URL}/version`, { 
          method: "GET",
          signal: AbortSignal.timeout(2000)
        });
        
        if (response.ok) {
          return new Response(JSON.stringify({ status: "connected" }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        } else {
          return new Response(JSON.stringify({ status: "disconnected" }), {
            status: 503,
            headers: { "Content-Type": "application/json" }
          });
        }
      } catch (error) {
        return new Response(JSON.stringify({ status: "error", message: error.message }), {
          status: 503,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
    
    // API route for chat completions
    if (url.pathname === "/api/chat" && req.method === "POST") {
      try {
        const body = await req.json();
        const { message, sessionId, model, memoryEnabled } = body;
        
        if (!message || !sessionId) {
          return new Response(
            JSON.stringify({ error: "Message and sessionId are required" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        
        if (!model) {
          return new Response(
            JSON.stringify({ error: "Model selection is required" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        
        // Add user message to session
        addMessageToSession(sessionId, "user", message);
        
        // Extract and store user information from the message
        extractUserInfo(sessionId, message);
        
        // Get existing context if available (only if memory is enabled)
        const existingContext = memoryEnabled ? getSessionContext(sessionId) : null;
        
        // Create system prompt with conversation history (only if memory is enabled)
        const systemPrompt = memoryEnabled ? createSystemPrompt(sessionId, model) :
          `You are a helpful and friendly AI assistant. Be conversational, natural, and personable in your responses. Feel free to be casual and engaging while still being informative and helpful.

You are running locally using Ollama with the ${model} model.`;
        
        console.log("System prompt:", systemPrompt);
        
        // Generate response from Ollama
        const result = await generateResponse(
          message,
          existingContext || [],
          systemPrompt,
          model,
          sessionId
        );
        
        // Add AI response to session (no automatic reference enhancement)
        addMessageToSession(sessionId, "ai", result.content);
        
        // Update session context (only if memory is enabled)
        if (memoryEnabled) {
          updateSessionContext(sessionId, result.context);
        }
        
        return new Response(
          JSON.stringify({ response: result.content }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      } catch (error) {
        console.error("Error processing chat request:", error);
        return new Response(
          JSON.stringify({ error: "Failed to process request" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }
    
    // API route for retrieving chat history
    if (url.pathname === "/api/history" && req.method === "GET") {
      try {
        const sessionId = url.searchParams.get("sessionId");
        
        if (!sessionId) {
          return new Response(
            JSON.stringify({ error: "SessionId is required" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        
        const history = getSessionHistory(sessionId);
        
        return new Response(
          JSON.stringify({ history }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      } catch (error) {
        console.error("Error retrieving chat history:", error);
        return new Response(
          JSON.stringify({ error: "Failed to retrieve history" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }
    
    // API route for managing reference contexts
    if (url.pathname === "/api/reference" && req.method === "POST") {
      try {
        const body = await req.json();
        const { sessionId, title, content } = body;
        
        if (!sessionId || !title || !content) {
          return new Response(
            JSON.stringify({ error: "SessionId, title, and content are required" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        
        console.log("Adding reference context for session:", sessionId, "title:", title);
        
        // Add reference context
        const id = addReferenceContext(sessionId, title, content);
        
        if (!id) {
            return new Response(
                JSON.stringify({ error: "Failed to add reference context" }),
                { status: 500, headers: { "Content-Type": "application/json" } }
            );
        }
        
        return new Response(
          JSON.stringify({ id, timestamp: Date.now() }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      } catch (error) {
        console.error("Error adding reference context:", error);
        return new Response(
          JSON.stringify({ error: "Failed to add reference context" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }
    
    // API route for retrieving reference contexts
    if (url.pathname === "/api/reference" && req.method === "GET") {
      try {
        const sessionId = url.searchParams.get("sessionId");
        
        if (!sessionId) {
          return new Response(
            JSON.stringify({ error: "SessionId is required" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        
        console.log("Getting reference contexts for session:", sessionId);
        
        // Direct database query to check all reference contexts
        const allReferences = db.query('SELECT * FROM reference_contexts').all();
        console.log("ALL REFERENCES IN DATABASE:", JSON.stringify(allReferences, null, 2));
        
        // Direct database query to check all sessions
        const allSessions = db.query('SELECT * FROM sessions').all();
        console.log("ALL SESSIONS IN DATABASE:", JSON.stringify(allSessions, null, 2));
        
        // Get reference contexts
        const contexts = getReferenceContexts(sessionId);
        console.log("Retrieved reference contexts for API:", contexts, "count:", contexts.length);
        
        // Return the contexts array directly, not wrapped in an object
        return new Response(
          JSON.stringify(contexts),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      } catch (error) {
        console.error("Error retrieving reference contexts:", error);
        return new Response(
          JSON.stringify({ error: "Failed to retrieve reference contexts" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }
    
    // API route for toggling reference context active status
    if (url.pathname === "/api/reference/toggle" && req.method === "POST") {
      try {
        const body = await req.json();
        const { id, isActive, sessionId } = body;
        
        if (!id) {
          return new Response(
            JSON.stringify({ error: "Reference context ID is required" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        
        console.log(`Toggling reference context ID ${id} to ${isActive ? 'active' : 'inactive'} for session ${sessionId || 'unknown'}`);
        
        // Toggle reference context
        const success = toggleReferenceContext(id, isActive);
        
        if (success) {
          return new Response(
            JSON.stringify({ success: true }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        } else {
          return new Response(
            JSON.stringify({ error: "Failed to toggle reference context" }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
        }
      } catch (error) {
        console.error("Error toggling reference context:", error);
        return new Response(
          JSON.stringify({ error: "Failed to toggle reference context" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }
    
    // API route for updating reference context
    if (url.pathname === "/api/reference/update" && req.method === "POST") {
      try {
        const body = await req.json();
        const { id, title, content, sessionId } = body;
        
        if (!id || !title || !content) {
          return new Response(
            JSON.stringify({ error: "ID, title, and content are required" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        
        console.log(`Updating reference context ID ${id} for session ${sessionId || 'unknown'}`);
        
        // Update reference context in database
        db.run('UPDATE reference_contexts SET title = ?, content = ? WHERE id = ?',
          [title, content, id]);
        
        return new Response(
          JSON.stringify({ success: true }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      } catch (error) {
        console.error("Error updating reference context:", error);
        return new Response(
          JSON.stringify({ error: "Failed to update reference context" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }
    
    // API route for deleting reference context
    if (url.pathname === "/api/reference/delete" && req.method === "POST") {
      try {
        const body = await req.json();
        const { id, sessionId } = body;
        
        if (!id) {
          return new Response(
            JSON.stringify({ error: "Reference context ID is required" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        
        console.log(`Deleting reference context ID ${id} for session ${sessionId || 'unknown'}`);
        
        // Delete reference context
        const success = deleteReferenceContext(id);
        
        if (success) {
          return new Response(
            JSON.stringify({ success: true }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        } else {
          return new Response(
            JSON.stringify({ error: "Failed to delete reference context" }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
        }
      } catch (error) {
        console.error("Error deleting reference context:", error);
        return new Response(
          JSON.stringify({ error: "Failed to delete reference context" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }
    
    // API route for getting all sessions
    if (url.pathname === "/api/sessions" && req.method === "GET") {
      try {
        const sessions = getAllSessions();
        return new Response(
          JSON.stringify(sessions),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      } catch (error) {
        console.error("Error retrieving sessions:", error);
        return new Response(
          JSON.stringify({ error: "Failed to retrieve sessions" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }
    
    // API route for creating a new session
    if (url.pathname === "/api/sessions" && req.method === "POST") {
      try {
        const body = await req.json();
        const { sessionId, title } = body;
        
        if (!sessionId) {
          return new Response(
            JSON.stringify({ error: "SessionId is required" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        
        // Create new session
        const session = getOrCreateSession(sessionId, title || 'New Chat');
        
        return new Response(
          JSON.stringify({ success: true, session }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      } catch (error) {
        console.error("Error creating session:", error);
        return new Response(
          JSON.stringify({ error: "Failed to create session" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }
    
    // API route for getting a specific session
    if (url.pathname.startsWith("/api/sessions/") && req.method === "GET") {
      try {
        const sessionId = url.pathname.split("/api/sessions/")[1];
        
        if (!sessionId) {
          return new Response(
            JSON.stringify({ error: "SessionId is required" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        
        const session = getOrCreateSession(sessionId);
        
        return new Response(
          JSON.stringify(session),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      } catch (error) {
        console.error("Error retrieving session:", error);
        return new Response(
          JSON.stringify({ error: "Failed to retrieve session" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }
    
    // API route for updating a session
    if (url.pathname.startsWith("/api/sessions/") && req.method === "PUT") {
      try {
        const sessionId = url.pathname.split("/api/sessions/")[1];
        const body = await req.json();
        const { title } = body;
        
        if (!sessionId || !title) {
          return new Response(
            JSON.stringify({ error: "SessionId and title are required" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        
        const success = updateSessionTitle(sessionId, title);
        
        if (success) {
          return new Response(
            JSON.stringify({ success: true }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        } else {
          return new Response(
            JSON.stringify({ error: "Failed to update session" }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
        }
      } catch (error) {
        console.error("Error updating session:", error);
        return new Response(
          JSON.stringify({ error: "Failed to update session" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }
    
    // API route for deleting a session
    if (url.pathname.startsWith("/api/sessions/") && req.method === "DELETE") {
      try {
        const sessionId = url.pathname.split("/api/sessions/")[1];
        
        if (!sessionId) {
          return new Response(
            JSON.stringify({ error: "SessionId is required" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        
        const success = deleteSession(sessionId);
        
        if (success) {
          return new Response(
            JSON.stringify({ success: true }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        } else {
          return new Response(
            JSON.stringify({ error: "Failed to delete session" }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
        }
      } catch (error) {
        console.error("Error deleting session:", error);
        return new Response(
          JSON.stringify({ error: "Failed to delete session" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }
    
    // API route for exporting all sessions
    if (url.pathname === "/api/sessions/export" && req.method === "GET") {
      try {
        const sessions = getAllSessions();
        const exportData = {
          exportDate: new Date().toISOString(),
          version: "1.0",
          sessions: []
        };
        
        // Get full session data including messages
        for (const session of sessions) {
          const messages = getSessionHistory(session.id);
          const context = getSessionContext(session.id);
          const userInfo = getUserInfo(session.id);
          
          exportData.sessions.push({
            id: session.id,
            title: session.title,
            created_at: session.created_at,
            last_activity: session.last_activity,
            messages: messages,
            context: context,
            userInfo: userInfo
          });
        }
        
        return new Response(
          JSON.stringify(exportData),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      } catch (error) {
        console.error("Error exporting sessions:", error);
        return new Response(
          JSON.stringify({ error: "Failed to export sessions" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }
    
    // API route for importing sessions
    if (url.pathname === "/api/sessions/import" && req.method === "POST") {
      try {
        const importData = await req.json();
        
        if (!importData.sessions || !Array.isArray(importData.sessions)) {
          return new Response(
            JSON.stringify({ error: "Invalid import data format" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        
        let importedCount = 0;
        
        // Import each session
        db.transaction(() => {
          for (const sessionData of importData.sessions) {
            try {
              // Create session
              db.run('INSERT OR REPLACE INTO sessions (id, title, created_at, last_activity) VALUES (?, ?, ?, ?)',
                [sessionData.id, sessionData.title, sessionData.created_at, sessionData.last_activity]);
              
              // Import messages
              if (sessionData.messages && Array.isArray(sessionData.messages)) {
                // Clear existing messages for this session
                db.run('DELETE FROM messages WHERE session_id = ?', [sessionData.id]);
                
                for (const message of sessionData.messages) {
                  db.run('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
                    [sessionData.id, message.role, message.content, message.timestamp]);
                }
              }
              
              // Import context
              if (sessionData.context) {
                db.run('INSERT OR REPLACE INTO contexts (session_id, context) VALUES (?, ?)',
                  [sessionData.id, JSON.stringify(sessionData.context)]);
              }
              
              // Import user info
              if (sessionData.userInfo && typeof sessionData.userInfo === 'object') {
                // Clear existing user info for this session
                db.run('DELETE FROM user_info WHERE session_id = ?', [sessionData.id]);
                
                for (const [key, value] of Object.entries(sessionData.userInfo)) {
                  db.run('INSERT INTO user_info (session_id, key, value, timestamp) VALUES (?, ?, ?, ?)',
                    [sessionData.id, key, value, Date.now()]);
                }
              }
              
              importedCount++;
            } catch (sessionError) {
              console.error(`Error importing session ${sessionData.id}:`, sessionError);
            }
          }
        })();
        
        return new Response(
          JSON.stringify({ success: true, imported: importedCount }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      } catch (error) {
        console.error("Error importing sessions:", error);
        return new Response(
          JSON.stringify({ error: "Failed to import sessions" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }
    
    // Handle 404 for unknown routes
    return new Response("Not Found", { status: 404 });
  }
});

// Clean up contaminated sessions on startup
cleanupContaminatedSessions();

// Server startup
console.log(`🤖 Local AI Assistant running at http://localhost:${PORT}`);
console.log(`📋 Make sure Ollama is running and you have models installed`);
console.log(`🔧 To install models: ollama pull <model-name> (e.g., ollama pull phi)`);
console.log(`🌐 Open your browser and navigate to: http://localhost:${PORT}`);
console.log(`💾 Conversation memory is persisted in SQLite database: ${DB_PATH}`);
console.log(`🧹 Contaminated conversation history has been cleaned up`);