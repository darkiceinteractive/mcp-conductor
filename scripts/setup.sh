#!/bin/bash
# MCP Conductor Setup Script
# Installs dependencies, verifies requirements, and optionally configures Claude

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "MCP Conductor - Setup"
echo "====================="
echo ""

# Check Node.js
echo "Checking Node.js..."
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js 18+ from https://nodejs.org"
    exit 1
fi
NODE_VERSION=$(node -v | sed 's/v//')
echo "✓ Node.js $NODE_VERSION"

# Check/Install Deno
echo ""
echo "Checking Deno..."
if ! command -v deno &> /dev/null; then
    echo "Deno not found. Installing..."

    # Detect OS and install
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS - prefer Homebrew if available
        if command -v brew &> /dev/null; then
            echo "Installing Deno via Homebrew..."
            brew install deno
        else
            echo "Installing Deno via official installer..."
            curl -fsSL https://deno.land/install.sh | sh
            export PATH="$HOME/.deno/bin:$PATH"
        fi
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        echo "Installing Deno via official installer..."
        curl -fsSL https://deno.land/install.sh | sh
        export PATH="$HOME/.deno/bin:$PATH"
    else
        echo "❌ Please install Deno manually: https://deno.land/#installation"
        exit 1
    fi

    # Verify installation
    if ! command -v deno &> /dev/null; then
        echo ""
        echo "⚠️  Deno installed but not in PATH. Add to your shell profile:"
        echo "   export PATH=\"\$HOME/.deno/bin:\$PATH\""
        echo ""
        echo "Then restart your terminal and run this script again."
        exit 1
    fi
fi
DENO_VERSION=$(deno --version | head -1 | sed 's/deno //')
echo "✓ Deno $DENO_VERSION"

# Install npm dependencies
echo ""
echo "Installing npm dependencies..."
npm install

# Build
echo ""
echo "Building..."
npm run build

# Verify
echo ""
echo "Verifying installation..."
node dist/bin/cli.js check

echo ""
echo "========================================"
echo "✓ Build complete!"
echo "========================================"

# Function to add MCP server to a config file
add_to_config() {
    local config_file="$1"
    local config_name="$2"

    if [[ ! -f "$config_file" ]]; then
        # Create new config file
        echo "Creating $config_name config..."
        mkdir -p "$(dirname "$config_file")"
        cat > "$config_file" << EOF
{
  "mcpServers": {
    "mcp-conductor": {
      "command": "node",
      "args": ["$PROJECT_DIR/dist/index.js"]
    }
  }
}
EOF
        echo "✓ Created $config_file"
        return 0
    fi

    # Check if already configured
    if grep -q "mcp-conductor" "$config_file" 2>/dev/null; then
        echo "✓ $config_name already has mcp-conductor configured"
        return 0
    fi

    # Add to existing config using node
    node -e "
        const fs = require('fs');
        const config = JSON.parse(fs.readFileSync('$config_file', 'utf8'));
        if (!config.mcpServers) config.mcpServers = {};
        config.mcpServers['mcp-conductor'] = {
            command: 'node',
            args: ['$PROJECT_DIR/dist/index.js']
        };
        fs.writeFileSync('$config_file', JSON.stringify(config, null, 2));
    " 2>/dev/null

    if [[ $? -eq 0 ]]; then
        echo "✓ Added mcp-conductor to $config_name"
    else
        echo "⚠️  Could not update $config_file automatically"
        return 1
    fi
}

# Ask about Claude Desktop
echo ""
CLAUDE_DESKTOP_CONFIG=""
if [[ "$OSTYPE" == "darwin"* ]]; then
    CLAUDE_DESKTOP_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    CLAUDE_DESKTOP_CONFIG="$HOME/.config/Claude/claude_desktop_config.json"
fi

if [[ -n "$CLAUDE_DESKTOP_CONFIG" ]]; then
    echo "Install to Claude Desktop? (y/n)"
    read -r response
    if [[ "$response" =~ ^[Yy]$ ]]; then
        add_to_config "$CLAUDE_DESKTOP_CONFIG" "Claude Desktop"
    fi
fi

# Ask about Claude Code
echo ""
CLAUDE_CODE_CONFIG="$HOME/.claude.json"
if [[ -f "$CLAUDE_CODE_CONFIG" ]] || [[ -d "$HOME/.claude" ]]; then
    # Claude Code uses ~/.claude.json or settings in ~/.claude/
    CLAUDE_CODE_CONFIG="$HOME/.claude.json"
fi

echo "Install to Claude Code? (y/n)"
read -r response
if [[ "$response" =~ ^[Yy]$ ]]; then
    add_to_config "$CLAUDE_CODE_CONFIG" "Claude Code"
fi

echo ""
echo "========================================"
echo "✓ Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Restart Claude Desktop and/or Claude Code"
echo "  2. Start using mcp-conductor!"
echo "========================================"
