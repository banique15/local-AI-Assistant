# Local AI Assistant

A lightweight, browser-based AI assistant that runs entirely on your local machine using Bun and Ollama. No cloud dependencies, complete privacy, and fast responses.

## Features

- 🤖 **Local AI Processing**: Uses Ollama with any installed model for fast, private AI responses
- 🔄 **Model Selection**: Automatically detects and allows switching between installed Ollama models
- 🧠 **Memory Toggle**: Enable/disable conversation context - choose between contextual or independent responses
- 🌐 **Web Interface**: Clean, responsive chat interface accessible via localhost
- 💾 **Persistent Memory**: Server-side SQLite database for conversation history that survives restarts
- 📝 **Dual Storage**: Client-side localStorage + server-side SQLite for robust persistence
- ⚡ **Single File**: Entire application in one JavaScript file using Bun
- 📊 **Real-time Status**: Connection status indicator showing current model, memory status, and Ollama service status
- 🧹 **Easy Management**: Clear chat history with one click

## Prerequisites

Before running the Local AI Assistant, ensure you have:

### 1. Bun (JavaScript Runtime)
```bash
# Install Bun on macOS or Linux
curl -fsSL https://bun.sh/install | bash

# Verify installation
bun --version
```

### 2. Ollama (Local AI Server)
```bash
# Install Ollama on macOS
curl -fsSL https://ollama.com/install.sh | sh

# Verify installation
ollama --version
```

### 3. Install AI Models
```bash
# Install recommended lightweight models
ollama pull phi          # Phi-2 (2.7B parameters - fast and efficient)
ollama pull llama3.2     # Llama 3.2 (3B parameters - good balance)
ollama pull mistral      # Mistral (7B parameters - more capable)

# Verify models are available
ollama list
```

## Quick Start

1. **Clone or download this repository**
2. **Start Ollama** (if not already running):
   ```bash
   ollama serve
   ```

3. **Run the application**:
   ```bash
   bun app.js
   ```

4. **Open your browser** and navigate to:
   ```
   http://localhost:3000
   ```

5. **Select a model** from the dropdown menu in the interface

6. **Start chatting** with your local AI assistant!

## Usage

### Basic Chat
- **Select a model**: Choose from available models in the dropdown
- **Toggle memory**: Use the Memory switch to enable/disable conversation context
- Type your message in the input field
- Press Enter or click "Send" to submit
- The AI will respond using your selected model with or without conversation context

### Features
- **Model Selection**: Automatically detects and lists all installed Ollama models
- **Memory Control**: Toggle switch to enable/disable conversation context
  - **Memory ON**: AI remembers previous messages and maintains conversation flow
  - **Memory OFF**: Each message is treated independently for focused, context-free responses
- **Model Information**: Shows model size and details in the dropdown
- **Multi-line input**: Use Shift+Enter for new lines
- **Clear chat**: Click "Clear" to start a new conversation
- **Status indicator**: Shows connection status, currently selected model, and memory status
- **Auto-scroll**: Chat automatically scrolls to show latest messages
- **Persistent settings**: Model selection and memory preference are saved in your browser

### Example Prompts
Try these to test your assistant:

```
Can you explain how JavaScript promises work?

Write a simple Python function to calculate the Fibonacci sequence

What are the advantages of running AI models locally?

Help me debug this code: [paste your code]
```

## Configuration

You can customize the application by modifying these variables at the top of `app.js`:

```javascript
const PORT = 3000;                              // Change server port
const OLLAMA_API_URL = "http://localhost:11434/api";  // Ollama API endpoint
const DEFAULT_MODEL = "phi";                    // Default model if none selected
```

### Model Management

The application automatically detects all installed Ollama models. To add more models:

```bash
# Install additional models
ollama pull llama3.2      # Llama 3.2 (3B parameters)
ollama pull mistral       # Mistral (7B parameters)
ollama pull codellama     # Code Llama (specialized for coding)
ollama pull tinyllama     # TinyLlama (1.1B parameters - very fast)

# List all installed models
ollama list

# Remove a model if needed
ollama rm [model-name]
```

The application will automatically refresh the model list when you reload the page.

## Troubleshooting

### Common Issues

**"Ollama service is not available"**
- Ensure Ollama is running: `ps aux | grep ollama`
- Start Ollama: `ollama serve`
- Check if port 11434 is available

**"Model not found" or "No models available"**
- Install models: `ollama pull phi` (or any other model)
- Verify with: `ollama list`
- Refresh the web page to reload the model list

**Slow responses**
- Switch to a smaller model like `tinyllama` using the dropdown
- Close other resource-intensive applications
- Check system resources (CPU/RAM usage)

**Browser issues**
- Try a different modern browser
- Clear browser cache and localStorage
- Check browser console for errors

### Logs and Debugging

View application logs in the terminal where you ran `bun app.js`. For more detailed logging:

```bash
# Run with debug output
DEBUG=* bun app.js
```

## Technical Details

### Architecture
- **Frontend**: HTML/CSS/JavaScript embedded in single file
- **Backend**: Bun HTTP server with REST API
- **AI**: Ollama API integration with context management
- **Storage**: Browser localStorage for chat history, in-memory sessions

### API Endpoints
- `GET /` - Serves the web interface
- `POST /api/chat` - Processes chat messages
- `GET /api/history` - Retrieves chat history
- `GET /api/status` - Checks Ollama connection status

### Performance Features
- Response caching for frequently asked questions
- Automatic session cleanup (24-hour expiry)
- Context window management for long conversations
- Efficient memory usage with cleanup routines

## Privacy & Security

- **100% Local**: No data sent to external servers
- **Private**: Conversations stay on your machine
- **Secure**: No API keys or cloud dependencies required
- **Offline**: Works without internet connection (after setup)

## Contributing

Feel free to enhance the application:

1. **Add features**: Voice input/output, file uploads, etc.
2. **Improve UI**: Better styling, dark mode, mobile optimization
3. **Extend functionality**: Multiple model support, conversation export
4. **Optimize performance**: Streaming responses, better caching

## License

This project is open source. Feel free to use, modify, and distribute as needed.

---

**Enjoy your private, local AI assistant!** 🤖✨