#!/bin/bash

# Function to check if Docker is available
check_docker() {
    docker info >/dev/null 2>&1
    return $?
}

# Function to pull an image with retries
pull_image() {
    local image=$1
    local max_attempts=5
    local attempt=1
    
    while [ $attempt -le $max_attempts ]; do
        echo "Attempting to pull $image (attempt $attempt of $max_attempts)..."
        if docker pull $image; then
            echo "Successfully pulled $image"
            return 0
        fi
        attempt=$((attempt + 1))
        echo "Waiting 5 seconds before retry..."
        sleep 5
    done
    
    echo "Failed to pull $image after $max_attempts attempts"
    return 1
}

# Wait for Docker to be available
echo "Waiting for Docker daemon to be available..."
max_wait=30
count=0
while ! check_docker && [ $count -lt $max_wait ]; do
    echo "Docker not available yet, waiting... ($count/$max_wait)"
    sleep 2
    count=$((count + 1))
done

if ! check_docker; then
    echo "WARNING: Docker daemon not available after ${max_wait} seconds"
    echo "Will attempt to start application anyway - images will be pulled on demand"
else
    # Pull required Docker images
    echo "Pulling required Docker images..."
    images=("python:3.9-slim" "node:16-alpine" "openjdk:11-slim" "gcc:11.2")
    
    for image in "${images[@]}"; do
        if ! pull_image "$image"; then
            echo "WARNING: Failed to pull $image - will attempt to pull on demand"
        fi
    done
fi

# Start the application
echo "Starting the application..."
exec npm start
