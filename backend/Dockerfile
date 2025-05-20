FROM node:16-slim

# Install Python
RUN apt-get update && \
    apt-get install -y python3 python3-pip && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

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

# Start script
CMD ["npm", "start"]
