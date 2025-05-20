const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;
const { PythonShell } = require('python-shell');

// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Store active sessions
const activeSessions = new Map();

// Ensure temp directory exists
const tempDir = path.join(__dirname, '../temp');
const ensureTempDir = async () => {
  try {
    await fs.mkdir(tempDir, { recursive: true });
    console.log('Temp directory created or already exists');
  } catch (err) {
    console.error('Error creating temp directory:', err);
  }
};

// Initialize temp directory
ensureTempDir();

// Maximum execution time in milliseconds (30 seconds)
const MAX_EXECUTION_TIME = 30000;

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('Client connected');
  const sessionId = uuidv4();
  
  // Create session directory
  const sessionDir = path.join(tempDir, sessionId);
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'run':
          await handleCodeExecution(ws, data, sessionId, sessionDir);
          break;
        case 'input':
          handleUserInput(ws, data, sessionId);
          break;
        case 'stop':
          console.log(`Received stop request for session ${sessionId}`);
          stopExecution(sessionId, ws);
          break;
        default:
          console.log('Unknown message type:', data.type);
      }
    } catch (err) {
      console.error('Error processing message:', err);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Error processing your request'
      }));
    }
  });
  
  ws.on('close', () => {
    console.log('Client disconnected');
    stopExecution(sessionId);
    // Clean up session directory
    cleanupSession(sessionId);
  });
  
  // Create a basic session entry
  activeSessions.set(sessionId, {
    language: 'python',
    initialized: true
  });
  
  // Send session ID to client
  ws.send(JSON.stringify({
    type: 'connected',
    sessionId
  }));
});

// Handle code execution
async function handleCodeExecution(ws, data, sessionId, sessionDir) {
  // Only allow Python execution for now
  if (data.language.toLowerCase() !== 'python') {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Only Python execution is currently supported.'
    }));
    ws.send(JSON.stringify({
      type: 'terminated',
      exitCode: 1
    }));
    return;
  }

  try {
    // Create session directory if it doesn't exist
    await fs.mkdir(sessionDir, { recursive: true });
    
    // Write code to file
    const filename = 'main.py';
    const filePath = path.join(sessionDir, filename);
    await fs.writeFile(filePath, data.code);
    
    // Notify client that execution has started
    ws.send(JSON.stringify({
      type: 'started'
    }));

    // Configure PythonShell options
    const options = {
      mode: 'text',
      pythonPath: 'python3',
      pythonOptions: ['-u'], // unbuffered output
      scriptPath: sessionDir,
      stdoutParser: (line) => line,
      stderrParser: (line) => line
    };

    // Create PythonShell instance
    const pyshell = new PythonShell(filename, options);
    
    // Store session information
    const timeoutId = setTimeout(() => {
      console.log(`Execution timeout reached (${MAX_EXECUTION_TIME}ms) for session ${sessionId}`);
      stopExecution(sessionId);
      ws.send(JSON.stringify({
        type: 'error',
        data: `Execution timed out after ${MAX_EXECUTION_TIME/1000} seconds.`
      }));
      ws.send(JSON.stringify({
        type: 'terminated',
        exitCode: 124
      }));
    }, MAX_EXECUTION_TIME);

    activeSessions.set(sessionId, {
      process: pyshell,
      timeoutId: timeoutId
    });

    // Handle output
    pyshell.stdout.on('data', (data) => {
      ws.send(JSON.stringify({
        type: 'output',
        data: data.toString()
      }));
    });

    pyshell.stderr.on('data', (data) => {
      ws.send(JSON.stringify({
        type: 'error',
        data: data.toString()
      }));
    });

    // Handle process end
    pyshell.end((err, exitCode) => {
      const session = activeSessions.get(sessionId);
      if (session && session.timeoutId) {
        clearTimeout(session.timeoutId);
      }

      if (err) {
        console.error('Python execution error:', err);
        ws.send(JSON.stringify({
          type: 'error',
          data: err.toString()
        }));
      }

      ws.send(JSON.stringify({
        type: 'terminated',
        exitCode: exitCode || 0
      }));

      activeSessions.delete(sessionId);
    });

  } catch (err) {
    console.error('Error executing code:', err);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Error executing code: ' + err.message
    }));
    ws.send(JSON.stringify({
      type: 'terminated',
      exitCode: 1
    }));
  }
}

// Handle user input
function handleUserInput(ws, data, sessionId) {
  const session = activeSessions.get(sessionId);
  
  if (session && session.process) {
    try {
      // Send input to Python process
      session.process.send(data.input + '\n');
      
      ws.send(JSON.stringify({
        type: 'inputProcessed',
        success: true
      }));
    } catch (err) {
      console.error('Error sending input:', err);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Error sending input: ' + err.message
      }));
    }
  } else {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'No active code execution. Please run your code first.'
    }));
  }
}

// Stop execution
function stopExecution(sessionId, ws = null) {
  const session = activeSessions.get(sessionId);
  if (session) {
    if (session.timeoutId) {
      clearTimeout(session.timeoutId);
    }
    
    if (session.process) {
      try {
        session.process.kill();
      } catch (err) {
        console.error('Error killing process:', err);
      }
    }
    
    if (ws) {
      ws.send(JSON.stringify({
        type: 'stopped',
        message: 'Execution stopped by user'
      }));
    }
    
    activeSessions.delete(sessionId);
  }
}

// Clean up session
async function cleanupSession(sessionId) {
  const sessionDir = path.join(tempDir, sessionId);
  try {
    await fs.rm(sessionDir, { recursive: true, force: true });
    console.log(`Cleaned up session directory: ${sessionId}`);
  } catch (err) {
    console.error(`Error cleaning up session directory ${sessionId}:`, err);
  }
}

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
