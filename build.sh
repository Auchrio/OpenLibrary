#!/bin/bash

# Build the OpenLibrary CLI binary for all supported platforms
# Output binaries are placed in the ./dist directory

set -e

OUTPUT_DIR="dist"
BINARY_NAME="library"

# Create output directory
mkdir -p "$OUTPUT_DIR"

echo "Building OpenLibrary CLI binaries..."
echo ""

# Define all target platforms
PLATFORMS=(
  "windows/amd64"
  "windows/arm"
  "windows/arm64"
  "linux/amd64"
  "linux/arm"
  "linux/arm64"
)

for platform in "${PLATFORMS[@]}"; do
  # Split platform into OS and architecture
  IFS='/' read -r OS ARCH <<< "$platform"
  
  # Determine binary extension
  if [ "$OS" = "windows" ]; then
    BINARY_OUTPUT="$OUTPUT_DIR/${BINARY_NAME}-${OS}-${ARCH}.exe"
  else
    BINARY_OUTPUT="$OUTPUT_DIR/${BINARY_NAME}-${OS}-${ARCH}"
  fi
  
  echo "Building for $OS/$ARCH..."
  GOOS=$OS GOARCH=$ARCH go build -o "$BINARY_OUTPUT" library.go
  
  # Show file size
  FILE_SIZE=$(du -h "$BINARY_OUTPUT" | cut -f1)
  echo "  ✓ $BINARY_OUTPUT ($FILE_SIZE)"
done

echo ""
echo "Build complete! Binaries are in the $OUTPUT_DIR directory."
echo ""
echo "Binaries built:"
ls -lh "$OUTPUT_DIR"
