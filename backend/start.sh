#!/bin/bash

# Pull required Docker images
echo "Pulling required Docker images..."
docker pull python:3.9-slim
docker pull node:16-alpine
docker pull openjdk:11-slim
docker pull gcc:11.2

# Start the application
echo "Starting the application..."
npm start
