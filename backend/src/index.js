const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;

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
  
  // Create a basic session entry immediately to prevent "No active session" errors
  activeSessions.set(sessionId, {
    language: 'python', // Default language
    initialized: true
  });
  
  // Send session ID to client
  ws.send(JSON.stringify({
    type: 'connected',
    sessionId
  }));
});

// Maximum execution time in milliseconds (30 seconds)
const MAX_EXECUTION_TIME = 30000;

// Check if Docker image exists locally
async function ensureDockerImage(ws, dockerImage) {
  return new Promise((resolve, reject) => {
    try {
      // First check if image exists
      const checkImageCmd = `docker image inspect ${dockerImage} > /dev/null 2>&1 || echo "not_found"`;
      const result = require('child_process').execSync(checkImageCmd, { encoding: 'utf8' });
      
      if (result.trim() === 'not_found') {
        console.log(`Docker image ${dockerImage} not found locally, attempting to pull...`);
        
        // Notify client that we're pulling the image
        ws.send(JSON.stringify({
          type: 'output',
          data: `Required environment not found. Setting up ${dockerImage} (this may take a moment)...\r\n`
        }));
        
        // Try to pull the image
        const { exec } = require('child_process');
        const pullProcess = exec(`docker pull ${dockerImage}`, { maxBuffer: 10 * 1024 * 1024 });
        
        pullProcess.stdout.on('data', (data) => {
          ws.send(JSON.stringify({
            type: 'output',
            data: `Setup progress: ${data.toString()}`
          }));
        });
        
        pullProcess.stderr.on('data', (data) => {
          ws.send(JSON.stringify({
            type: 'output',
            data: `Setup info: ${data.toString()}`
          }));
        });
        
        pullProcess.on('close', (pullCode) => {
          if (pullCode === 0) {
            console.log(`Successfully pulled Docker image ${dockerImage}`);
            ws.send(JSON.stringify({
              type: 'output',
              data: `Environment is ready. Running your code...\r\n`
            }));
            resolve();
          } else {
            console.error(`Failed to pull Docker image ${dockerImage}`);
            reject(new Error(`Failed to set up the required environment. Please try again later.`));
          }
        });
        
        pullProcess.on('error', (err) => {
          console.error(`Error pulling Docker image: ${err.message}`);
          reject(new Error(`Failed to set up the required environment: ${err.message}`));
        });
      } else {
        // Image exists locally
        console.log(`Docker image ${dockerImage} found locally`);
        
        // Send ready message to client
        ws.send(JSON.stringify({
          type: 'output',
          data: `Environment ready. Running your code...\r\n`
        }));
        
        resolve();
      }
    } catch (err) {
      console.error(`Error in ensureDockerImage: ${err.message}`);
      reject(new Error(`Failed to check environment status: ${err.message}`));
    }
  });
}

// Handle code execution
async function handleCodeExecution(ws, data, sessionId, sessionDir) {
  try {
    // Notify client that we're starting execution
    ws.send(JSON.stringify({
      type: 'output',
      data: `Starting ${data.language} code execution...\r\n`
    }));
    
    // Create session directory if it doesn't exist
    await fs.mkdir(sessionDir, { recursive: true });
    
    // Get filename based on language
    const filename = getFilename(data.language);
    
    // Write code to file
    const filePath = path.join(sessionDir, filename);
    await fs.writeFile(filePath, data.code);
    
    // Get Docker image for the language
    const dockerImage = getDockerImage(data.language);
    
    // Check if Docker image exists locally, pull if not
    try {
      await ensureDockerImage(ws, dockerImage);
    } catch (imageError) {
      console.error(`Error ensuring Docker image ${dockerImage}:`, imageError);
      ws.send(JSON.stringify({
        type: 'error',
        message: `Failed to prepare Docker image for ${data.language}. Please try again.`
      }));
      ws.send(JSON.stringify({
        type: 'terminated',
        exitCode: 1
      }));
      return;
    }
    
    // Stop any existing execution for this session
    stopExecution(sessionId);
    
    // Create container name
    const containerName = `zad-compiler-${sessionId}`;
    
    // Create a new session entry to prevent "No active session" errors
    activeSessions.set(sessionId, {
      containerId: containerName,
      language: data.language
    });
    
    // Notify client that execution has started
    ws.send(JSON.stringify({
      type: 'started',
      sessionId
    }));
    
    // Create and run Docker container
    
    // Command to run the code
    const runCommand = getRunCommand(data.language, filename);
    
    // Run Docker container with TTY
    const dockerArgs = [
      'run',
      '--name', containerName,
      '-i',
      '--rm',
      '-v', `${sessionDir}:/code`,
      '-w', '/code',
      '--memory', '512m',
      '--cpus', '0.5',
      '--network', 'none',
      dockerImage,
      ...runCommand
    ];
    
    console.log('Running Docker command:', 'docker', dockerArgs.join(' '));
    
    const dockerProcess = spawn('docker', dockerArgs);
    
    // Set up execution timeout
    const timeoutId = setTimeout(() => {
      console.log(`Execution timeout reached (${MAX_EXECUTION_TIME}ms) for session ${sessionId}`);
      
      // Notify the client
      ws.send(JSON.stringify({
        type: 'error',
        data: `Execution timed out after ${MAX_EXECUTION_TIME/1000} seconds. The process has been terminated.`
      }));
      
      // Terminate the process
      stopExecution(sessionId);
      
      // Send terminated event
      ws.send(JSON.stringify({
        type: 'terminated',
        exitCode: 124 // Standard timeout exit code
      }));
    }, MAX_EXECUTION_TIME);
    
    // Store process reference and timeout ID
    activeSessions.set(sessionId, {
      process: dockerProcess,
      containerId: containerName,
      timeoutId: timeoutId
    });
    
    // Send output to client
    dockerProcess.stdout.on('data', (data) => {
      console.log('Docker stdout:', data.toString());
      ws.send(JSON.stringify({
        type: 'output',
        data: data.toString()
      }));
    });
    
    dockerProcess.stderr.on('data', (data) => {
      console.log('Docker stderr:', data.toString());
      ws.send(JSON.stringify({
        type: 'error',
        data: data.toString()
      }));
    });
    
    dockerProcess.on('close', (code) => {
      console.log('Docker process closed with code:', code);
      
      // Clear the timeout since the process has ended naturally
      const session = activeSessions.get(sessionId);
      if (session && session.timeoutId) {
        clearTimeout(session.timeoutId);
      }
      
      ws.send(JSON.stringify({
        type: 'terminated',
        exitCode: code
      }));
      
      // Remove from active sessions
      activeSessions.delete(sessionId);
    });
    
    dockerProcess.on('error', (err) => {
      console.error('Docker process error:', err);
      
      // Clear the timeout since the process has errored
      const session = activeSessions.get(sessionId);
      if (session && session.timeoutId) {
        clearTimeout(session.timeoutId);
      }
      
      ws.send(JSON.stringify({
        type: 'error',
        data: `Error executing Docker: ${err.message}`
      }));
      
      // Also send terminated event to ensure UI is updated
      ws.send(JSON.stringify({
        type: 'terminated',
        exitCode: 1
      }));
    });
  } catch (err) {
    console.error('Error executing code:', err);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Error executing code: ' + err.message
    }));
    
    // Send terminated event to ensure UI is updated
    ws.send(JSON.stringify({
      type: 'terminated',
      exitCode: 1
    }));
  }
}



// Handle user input
function handleUserInput(ws, data, sessionId) {
  const session = activeSessions.get(sessionId);
  
  // Check if we have a valid session with a process
  if (session && session.process && session.process.stdin) {
    console.log('Sending input to process:', data.input);
    // Send the input followed by a newline
    // The input from frontend no longer includes the newline
    try {
      session.process.stdin.write(data.input + '\n');
      
      // Send confirmation back to client
      ws.send(JSON.stringify({
        type: 'inputProcessed',
        success: true
      }));
    } catch (err) {
      console.error('Error sending input to process:', err);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Error sending input to process: ' + err.message
      }));
    }
  } else {
    console.log('No active process for input in session:', sessionId);
    
    // Check if we have a partial session (waiting for Docker)
    if (session && !session.process) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Code execution is still initializing. Please wait a moment and try again.'
      }));
    } else if (session) {
      // We have a session but no process
      ws.send(JSON.stringify({
        type: 'error',
        message: 'No active code execution. Please run your code first.'
      }));
    } else {
      // No session at all - this shouldn't happen with our initialization
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Session not found. Please refresh the page and try again.'
      }));
    }
  }
}

// Stop execution
function stopExecution(sessionId, ws = null) {
  const session = activeSessions.get(sessionId);
  if (session) {
    console.log(`Stopping execution for session ${sessionId}`);
    
    // Clear timeout if it exists
    if (session.timeoutId) {
      clearTimeout(session.timeoutId);
    }
    
    // Kill the process if it exists
    if (session.process) {
      try {
        session.process.kill('SIGKILL');
      } catch (err) {
        console.error('Error killing process:', err);
      }
    }
    
    // Force stop the container if it exists
    if (session.containerId) {
      try {
        // Use force flag to ensure container is stopped immediately
        spawn('docker', ['stop', '--time=0', session.containerId]);
        console.log(`Container ${session.containerId} stopped`);
        
        // Make sure to remove the container if it still exists
        setTimeout(() => {
          try {
            spawn('docker', ['rm', '-f', session.containerId]);
            console.log(`Container ${session.containerId} removed`);
          } catch (rmErr) {
            console.error('Error removing container:', rmErr);
          }
        }, 500);
      } catch (err) {
        console.error('Error stopping container:', err);
      }
    }
    
    // Send stopped message to client if WebSocket is provided
    // This helps the frontend know that the process was stopped manually
    if (ws) {
      try {
        ws.send(JSON.stringify({
          type: 'stopped',
          message: 'Execution stopped by user'
        }));
      } catch (wsErr) {
        console.error('Error sending stopped message:', wsErr);
      }
    }
    
    // Remove from active sessions
    activeSessions.delete(sessionId);
    console.log(`Session ${sessionId} removed from active sessions`);
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

// Helper functions
function getFilename(language) {
  switch (language.toLowerCase()) {
    case 'python':
      return 'main.py';
    case 'javascript':
      return 'main.js';
    case 'java':
      return 'Main.java';
    case 'c':
      return 'main.c';
    case 'cpp':
      return 'main.cpp';
    default:
      return 'main.py';
  }
}

function getDockerImage(language) {
  switch (language.toLowerCase()) {
    case 'python':
      return 'python:3.9-slim';
    case 'javascript':
      return 'node:16-alpine';
    case 'java':
      return 'openjdk:11-slim';
    case 'c':
    case 'cpp':
      return 'gcc:11.2';
    default:
      return 'python:3.9-slim';
  }
}

function getRunCommand(language, filename) {
  switch (language.toLowerCase()) {
    case 'python':
      return ['python', filename];
    case 'javascript':
      return ['node', filename];
    case 'java':
      return ['bash', '-c', `javac ${filename} && java Main`];
    case 'c':
      return ['bash', '-c', `gcc ${filename} -o main && ./main`];
    case 'cpp':
      return ['bash', '-c', `g++ ${filename} -o main && ./main`];
    default:
      return ['python', filename];
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
