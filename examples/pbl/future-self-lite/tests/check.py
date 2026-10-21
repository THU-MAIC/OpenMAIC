import pathlib
import sys

sys.path.insert(0, str(pathlib.Path.cwd() / "src"))
from main import future_message

for name in ["小雨", "Ada", ""]:
    assert future_message(name) == f"给未来的{name}：继续保持好奇心。", repr(name)

print("future-self-lite: 3 checks passed")
