#!/usr/bin/env bash
# =============================================================================
# OpenMAIC Local Deployment Script
# =============================================================================
set -euo pipefail

echo "=========================================="
echo "  OpenMAIC Local Deployment"
echo "=========================================="

# Check prerequisites
echo ""
echo "[1/4] Checking prerequisites..."

if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed. Please install Node.js >= 20."
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "Error: Node.js version must be >= 20. Current: $(node -v)"
    exit 1
fi
echo "  Node.js: $(node -v) ✓"

if ! command -v pnpm &> /dev/null; then
    echo "pnpm not found. Installing via corepack..."
    corepack enable
    corepack prepare pnpm@10.28.0 --activate
fi
echo "  pnpm: $(pnpm -v) ✓"

# Create .env.local if not exists
echo ""
echo "[2/4] Checking configuration..."

if [ ! -f .env.local ]; then
    cp .env.example .env.local
    echo "  Created .env.local from .env.example"
    echo "  ⚠  Please edit .env.local and add at least one LLM API key"
    echo "     (e.g., OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY)"
    echo ""
    echo "  Recommended: Set GOOGLE_API_KEY for Gemini 3 Flash (best speed/quality)"
    echo ""
fi
echo "  .env.local exists ✓"

# Install dependencies
echo ""
echo "[3/4] Installing dependencies..."
pnpm install

# Start dev server
echo ""
echo "[4/4] Starting development server..."
echo ""
echo "=========================================="
echo "  OpenMAIC is starting at:"
echo "  http://localhost:3000"
echo "=========================================="
echo ""

pnpm dev
