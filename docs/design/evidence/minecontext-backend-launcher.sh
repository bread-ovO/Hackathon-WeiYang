#!/bin/sh
cd /tmp/minecontext-research-20260912
export CONTEXT_PATH=/tmp/minecontext-design-backend-20260912
exec .venv/bin/python -m opencontext.cli "$@"
