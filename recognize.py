import subprocess
import sys
from pocketsphinx import Decoder

pcm = subprocess.run(
    ["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-ac", "1",
     "-ar", "16000", "-f", "s16le", "pipe:1"],
    input=sys.stdin.buffer.read(), stdout=subprocess.PIPE, check=True,
).stdout
decoder = Decoder()
decoder.add_jsgf_string("commands", """#JSGF V1.0;
grammar commands;
public <command> = read the file | write the code | open the folder;
""")
decoder.activate_search("commands")
decoder.start_utt()
decoder.process_raw(pcm, False, True)
decoder.end_utt()
print(decoder.hyp().hypstr if decoder.hyp() else "")
