#!/bin/bash
set -euo pipefail
python3 tools/lint.py
python3 -m unittest discover -s tests
echo "all checks passed"
