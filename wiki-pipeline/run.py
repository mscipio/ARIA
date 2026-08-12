#!/usr/bin/env python3
"""Quick-start CLI for the Wiki Pipeline."""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from compiler import main
if __name__ == "__main__":
    main()
