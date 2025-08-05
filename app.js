// Local AI Assistant - Single File Bun Application
// Uses Ollama for local AI processing with a web interface

// Import SQLite from Bun
import { Database } from 'bun:sqlite';

// Configuration
const PORT = 3000;
const OLLAMA_API_URL = "http://localhost:11434/api";
const DEFAULT_MODEL = "phi"; // Default model if none selected
const DB_PATH = "chat_memory.sqlite";

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
async function generateResponse(prompt, context = [], systemPrompt = "", modelName = DEFAULT_MODEL) {
  try {
    // Check if Ollama is available
    const healthCheck = await fetch(`${OLLAMA_API_URL}/version`, { 
      method: "GET",
      signal: AbortSignal.timeout(2000) // 2-second timeout
    }).catch(() => null);
    
    if (!healthCheck || !healthCheck.ok) {
      throw new Error("Ollama service is not available");
    }

    // Check cache first
    const cacheKey = `${modelName}:${prompt}`;
    const cachedResponse = responseCache.get(cacheKey);
    if (cachedResponse) {
      return cachedResponse;
    }

    const response = await fetch(`${OLLAMA_API_URL}/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        prompt: prompt,
        system: systemPrompt,
        context: context,
        stream: false,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Ollama API error: ${response.status} - ${errorData.error || "Unknown error"}`);
    }

    const data = await response.json();
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
    console.error("Error calling Ollama API:", error);
    
    // Provide helpful error messages based on error type
    if (error.message.includes("not available")) {
      return {
        content: "I'm having trouble connecting to the Ollama service. Please make sure Ollama is running and try again.",
        context: context,
      };
    } else if (error.message.includes("not found")) {
      return {
        content: `The model "${modelName}" was not found. Please make sure it's downloaded using "ollama pull ${modelName}" and try again.`,
        context: context,
      };
    } else {
      return {
        content: "Sorry, I encountered an error processing your request. Please try again later.",
        context: context,
      };
    }
  }
}

// Session Management Functions with SQLite persistence
function getOrCreateSession(sessionId) {
  try {
    const now = Date.now();
    
    // Check if session exists
    const existingSession = db.query('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    
    if (!existingSession) {
      // Create new session
      db.run('INSERT INTO sessions (id, created_at, last_activity) VALUES (?, ?, ?)',
        [sessionId, now, now]);
      return {
        id: sessionId,
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

function formatConversationForSystemPrompt(sessionId, maxMessages = 10) {
  const session = getOrCreateSession(sessionId);
  const recentMessages = session.messages.slice(-maxMessages);
  
  return recentMessages.map(msg => 
    `${msg.role === 'user' ? 'Human' : 'Assistant'}: ${msg.content}`
  ).join('\n\n');
}

function createSystemPrompt(sessionId, modelName = DEFAULT_MODEL) {
  const conversationHistory = formatConversationForSystemPrompt(sessionId);
  
  return `You are a formal, high-context AI assistant who speaks in polished, professional English. Maintain memory of past interactions and always reference relevant historical context when replying. Avoid small talk or filler. Be direct, informative, and structured in responses. If information is missing, request it explicitly.

You are running locally using Ollama with the ${modelName} model.

Here is the recent conversation history for context:

${conversationHistory}

Please respond in a formal, structured, and informative manner, referencing relevant context from previous exchanges when appropriate.`;
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
            padding: 1rem;
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
            background: var(--bg-color);
            scroll-behavior: smooth;
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
            </div>
            <div id="status-indicator" class="status-indicator">Connecting...</div>
        </header>
        
        <div id="chat-container" class="chat-container">
            <div class="system-message">Start a conversation with your local AI assistant</div>
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
    
    <script>
        // DOM Elements
        const chatContainer = document.getElementById('chat-container');
        const userInput = document.getElementById('user-input');
        const sendButton = document.getElementById('send-button');
        const clearButton = document.getElementById('clear-chat');
        const statusIndicator = document.getElementById('status-indicator');
        const modelSelector = document.getElementById('model-selector');
        const memoryToggle = document.getElementById('memory-toggle');

        // Session management
        let sessionId = localStorage.getItem('sessionId') || generateSessionId();
        let messageHistory = JSON.parse(localStorage.getItem('messageHistory_' + sessionId) || '[]');
        let selectedModel = localStorage.getItem('selectedModel') || '';
        let memoryEnabled = localStorage.getItem('memoryEnabled') !== 'false'; // Default to true

        // Initialize chat with stored messages
        function initChat() {
            localStorage.setItem('sessionId', sessionId);
            
            // Display stored messages
            if (messageHistory.length > 0) {
                chatContainer.innerHTML = '';
                messageHistory.forEach(message => {
                    addMessageToUI(message.role, message.content);
                });
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
            modelSelector.addEventListener('change', function() {
                selectedModel = this.value;
                localStorage.setItem('selectedModel', selectedModel);
                updateStatusIndicator();
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
                sessionId = generateSessionId();
                localStorage.setItem('sessionId', sessionId);
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
                
                // Add AI response to UI and history
                addMessageToUI('ai', data.response);
                saveMessage('ai', data.response);
            } catch (error) {
                console.error('Error:', error);
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
        
        // Get existing context if available (only if memory is enabled)
        const existingContext = memoryEnabled ? getSessionContext(sessionId) : null;
        
        // Create system prompt with conversation history (only if memory is enabled)
        const systemPrompt = memoryEnabled ? createSystemPrompt(sessionId, model) :
          `You are a formal, high-context AI assistant who speaks in polished, professional English. Avoid small talk or filler. Be direct, informative, and structured in responses. If information is missing, request it explicitly.

You are running locally using Ollama with the ${model} model.`;
        
        // Generate response from Ollama
        const result = await generateResponse(
          message,
          existingContext || [],
          systemPrompt,
          model
        );
        
        // Add AI response to session
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
    
    // Handle 404 for unknown routes
    return new Response("Not Found", { status: 404 });
  }
});

// Server startup
console.log(`🤖 Local AI Assistant running at http://localhost:${PORT}`);
console.log(`📋 Make sure Ollama is running and you have models installed`);
console.log(`🔧 To install models: ollama pull <model-name> (e.g., ollama pull phi)`);
console.log(`🌐 Open your browser and navigate to: http://localhost:${PORT}`);
console.log(`💾 Conversation memory is persisted in SQLite database: ${DB_PATH}`);