import pathlib
import sys

sys.path.insert(0, str(pathlib.Path.cwd() / "src"))
from main import future_message

# Observe the implementation. The host owns the expected values and verdict.
print(future_message(sys.argv[1]))
