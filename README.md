[![VS Code Marketplace](https://img.shields.io/badge/VS_Code-ZnDraw-darkcyan)](https://marketplace.visualstudio.com/items?itemName=PythonFZ.vscode-zndraw)

# vscode-zndraw
Open supported files using ZnDraw and UV directly from VSCode.

## Features
This extension will use the ZnDraw from your current environment.
To get started, try creating a new project like
```bash
mkdir my-zndraw-project
cd my-zndraw-project
uv init
uv add zndraw
```

Then create a new file like
```python
import molify
import ase.io

frames = molify.smiles2conformers("CCO", 10)
ase.io.write("ethanol.xyz", frames)
```
Run `uv run main.py` and then right click on the `ethanol.xyz` file in the VSCode explorer and select "Open with ZnDraw".


## Configuration

You can configure the extension in your `.vscode/settings.json`:

```json
{
  "zndraw.command": "zndraw",
  "zndraw.port": 5000,
  "zndraw.serverUrl": "",
  "zndraw.autoStart": false,
  "zndraw.extraArgs": []
}
```

### Available Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `zndraw.command` | string | `zndraw` | Command to run ZnDraw (e.g., `uvx zndraw`, `uv run zndraw`, `zndraw`) |
| `zndraw.port` | number | `5000` | Port for the local ZnDraw server |
| `zndraw.serverUrl` | string | `""` | Remote ZnDraw server URL (e.g., `https://zndraw.icp.uni-stuttgart.de`). Leave empty to use local server |
| `zndraw.autoStart` | boolean | `false` | Automatically start ZnDraw server when VS Code opens |
| `zndraw.extraArgs` | array | `[]` | Additional arguments to pass to ZnDraw |

## Testing the Extension

1. Open this project in VSCode
2. Press `F5` to launch the Extension Development Host
3. A new VSCode window will open with the extension loaded
4. Open a supported file to test the extension functionality
