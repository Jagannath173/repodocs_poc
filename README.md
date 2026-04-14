# Internal Python Runner Extension

This Visual Studio Code extension runs a bundled Python script and automatically manages a virtual environment so external dependencies are installed when needed.

## What It Does

- Provides the command `Run Internal Python Script`
- Bundles Python files under `python/`:
  - `python/script.py`
  - `python/requirements.txt`
- On first run:
  - Detects a system Python interpreter
  - Creates `python/venv`
  - Installs dependencies from `requirements.txt` using pip
- On subsequent runs:
  - Reuses the existing virtual environment
- Executes the bundled Python script with the venv interpreter
- Streams script output and setup logs in real time to the `Internal Python Runner` output channel

## Python Script Behavior

`python/script.py` uses `requests` to call:

- `https://api.publicapis.org/entries`

It prints:

- A success line
- Total count of API entries returned
- A sample API name and description

## Dependency Handling

The extension checks whether the venv interpreter exists:

- Windows: `python/venv/Scripts/python.exe`
- macOS/Linux: `python/venv/bin/python`

If missing, it creates the environment and installs dependencies. If present, setup is skipped.

## How to Run (F5)

1. Open this project in VS Code.
2. Install dependencies:
   - `npm install`
3. Compile:
   - `npm run compile`
4. Press `F5` to launch an Extension Development Host.
5. In the new window, open Command Palette and run:
   - `Run Internal Python Script`

## Notes

- Requires Python to be installed and available in `PATH`.
- Uses `child_process.spawn` (not `exec`) for robust process streaming.
- Errors (Python missing, venv creation failure, pip install failure, script failure) are surfaced in both the Output channel and user-facing VS Code notifications.
