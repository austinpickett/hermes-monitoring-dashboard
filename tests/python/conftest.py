"""Keep the standalone repository importable under either pytest entry point."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2] / "plugin"
sys.path.insert(0, str(ROOT))
