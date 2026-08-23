@echo off
rem Sobe o llama-server com Qwen 3 (OpenAI-compatible em :11434)
set LLAMA=C:\Users\junin\second-brain\tools\llamacpp
set MODEL=C:\Users\junin\second-brain\tools\models\qwen3-1.7b-q4_k_m.gguf
"%LLAMA%\llama-server.exe" -m "%MODEL%" --port 11434 --host 127.0.0.1 -c 4096 --jinja
