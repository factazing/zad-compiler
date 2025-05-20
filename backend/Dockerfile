FROM node:16-slim

# Install Docker and other dependencies
RUN apt-get update && \
    apt-get install -y \
    apt-transport-https \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    build-essential \
    python3 \
    make \
    g++ && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
    $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null && \
    apt-get update && \
    apt-get install -y docker-ce-cli

# Pre-pull all required Docker images
RUN docker pull python:3.9-slim && \
    docker pull node:16-alpine && \
    docker pull openjdk:11-slim && \
    docker pull gcc:11.2

# Create app directory
WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy app source
COPY . .

# Create temp directory for code execution
RUN mkdir -p temp

# Expose port (use PORT from environment variable)
EXPOSE ${PORT:-3001}

# Start the server
CMD ["npm", "start"]
