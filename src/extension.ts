import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';

let serverProcess: child_process.ChildProcess | null = null;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
const webviewPanels: Map<string, vscode.WebviewPanel> = new Map();

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('ZnDraw');

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'zndraw.toggleServer';
    updateStatusBar();
    statusBarItem.show();

    const openFileCmd = vscode.commands.registerCommand('zndraw.openFile', async (uri: vscode.Uri) => {
        if (!uri) {
            vscode.window.showErrorMessage('No file selected');
            return;
        }
        await startServerWithFile(uri.fsPath);
    });

    const startServerCmd = vscode.commands.registerCommand('zndraw.startServer', async () => {
        await startServer();
    });

    const stopServerCmd = vscode.commands.registerCommand('zndraw.stopServer', async () => {
        await stopServer();
    });

    const openViewerCmd = vscode.commands.registerCommand('zndraw.openViewer', async () => {
        await openOrUpdateWebview();
    });

    const toggleServerCmd = vscode.commands.registerCommand('zndraw.toggleServer', async () => {
        if (serverProcess) {
            await stopServer();
        } else {
            await startServer();
        }
    });

    context.subscriptions.push(
        openFileCmd,
        startServerCmd,
        stopServerCmd,
        openViewerCmd,
        toggleServerCmd,
        outputChannel,
        statusBarItem
    );

    // Auto-start if configured
    const config = vscode.workspace.getConfiguration('zndraw');
    if (config.get<boolean>('autoStart')) {
        startServer();
    }
}

function getConfig() {
    const config = vscode.workspace.getConfiguration('zndraw');
    const serverUrl = config.get<string>('serverUrl') || '';
    const port = config.get<number>('port') || 5000;

    return {
        command: config.get<string>('command') || 'uvx zndraw',
        port,
        serverUrl,
        extraArgs: config.get<string[]>('extraArgs') || [],
        isRemote: serverUrl.length > 0,
        baseUrl: serverUrl || `http://localhost:${port}`
    };
}

async function startServer(): Promise<void> {
    if (serverProcess) {
        vscode.window.showInformationMessage('ZnDraw is already running');
        return;
    }

    const { command, port, extraArgs, isRemote, serverUrl } = getConfig();

    let args: string[];
    if (isRemote) {
        // Connect to remote server
        args = ['--connect', serverUrl, ...extraArgs];
    } else {
        // Start local server
        args = ['--port', port.toString(), '--no-browser', ...extraArgs];
    }

    await spawnServer(command, args);
}

async function startServerWithFile(filePath: string): Promise<void> {
    const { command, port, extraArgs, isRemote, serverUrl, baseUrl } = getConfig();

    // If server is running, use the upload API instead
    if (serverProcess) {
        // Open loading webview immediately
        const loadingPanel = openLoadingWebview(path.basename(filePath));

        const roomId = await uploadFile(filePath, baseUrl);
        if (roomId) {
            // Update to the actual room URL
            updateWebviewToRoom(loadingPanel, roomId);
        }
        return;
    }

    let args: string[];
    if (isRemote) {
        // Connect to remote server with file
        args = [filePath, '--connect', serverUrl, ...extraArgs];
    } else {
        // Start local server with file
        args = [filePath, '--port', port.toString(), '--no-browser', ...extraArgs];
    }

    await spawnServer(command, args, filePath);
}

async function spawnServer(command: string, args: string[], filePath?: string): Promise<void> {
    const parts = command.split(' ');
    const cmd = parts[0];
    const cmdArgs = [...parts.slice(1), ...args];

    // Use workspace folder or home directory as cwd so zndraw-data is writable
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const cwd = workspaceFolder || process.env.HOME || process.cwd();

    outputChannel.clear();
    outputChannel.show();
    outputChannel.appendLine(`Starting ZnDraw: ${cmd} ${cmdArgs.join(' ')}`);
    outputChannel.appendLine(`Working directory: ${cwd}`);

    // Open loading webview immediately if we have a file
    let loadingPanel: vscode.WebviewPanel | undefined;
    if (filePath) {
        loadingPanel = openLoadingWebview(path.basename(filePath));
    }

    serverProcess = child_process.spawn(cmd, cmdArgs, {
        shell: true,
        cwd,
        env: { ...process.env }
    });

    serverProcess.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        outputChannel.append(text);

        // Check if server is ready and parse room URL
        if (text.includes('Running on') || text.includes('localhost')) {
            const { port } = getConfig();
            vscode.window.showInformationMessage(`ZnDraw running on http://localhost:${port}`);
        }

        // Look for room URL in output (e.g., "Opening browser at http://localhost:5000/rooms/room_id")
        const roomMatch = text.match(/\/rooms\/([^\s\n"']+)/);
        if (roomMatch && loadingPanel) {
            const roomId = roomMatch[1];
            outputChannel.appendLine(`Detected room: ${roomId}`);
            updateWebviewToRoom(loadingPanel, roomId);
            loadingPanel = undefined; // Don't update again
        }
    });

    serverProcess.stderr?.on('data', (data: Buffer) => {
        outputChannel.append(data.toString());
    });

    serverProcess.on('close', (code) => {
        outputChannel.appendLine(`ZnDraw server exited with code ${code}`);
        serverProcess = null;
        updateStatusBar();
    });

    serverProcess.on('error', (err) => {
        outputChannel.appendLine(`Failed to start ZnDraw: ${err.message}`);
        vscode.window.showErrorMessage(`Failed to start ZnDraw: ${err.message}`);
        serverProcess = null;
        updateStatusBar();
    });

    updateStatusBar();

    // Aggressively poll for default room
    if (loadingPanel) {
        pollForRoom(loadingPanel);
    }
}

async function pollForRoom(panel: vscode.WebviewPanel, attempt: number = 0): Promise<void> {
    const maxAttempts = 30;
    const intervalMs = 500; // Poll every 500ms

    if (attempt >= maxAttempts || !serverProcess) {
        outputChannel.appendLine(`Room polling stopped after ${attempt} attempts`);
        return;
    }

    const { baseUrl } = getConfig();

    try {
        const roomId = await getDefaultRoom(baseUrl);
        if (roomId) {
            updateWebviewToRoom(panel, roomId);
            return;
        }
    } catch {
        // Server not ready yet, continue polling
    }

    // Retry after interval
    setTimeout(() => pollForRoom(panel, attempt + 1), intervalMs);
}

async function stopServer(): Promise<void> {
    if (!serverProcess) {
        vscode.window.showInformationMessage('ZnDraw server is not running');
        return;
    }

    outputChannel.appendLine('Stopping ZnDraw server...');

    // Use zndraw --shutdown for graceful shutdown
    await runZndrawShutdown();

    // Force kill the process if still running
    if (serverProcess) {
        serverProcess.kill('SIGTERM');

        // Force kill after timeout
        setTimeout(() => {
            if (serverProcess) {
                serverProcess.kill('SIGKILL');
                serverProcess = null;
                updateStatusBar();
            }
        }, 3000);
    }

    serverProcess = null;
    updateStatusBar();
    vscode.window.showInformationMessage('ZnDraw server stopped');
}

async function runZndrawShutdown(): Promise<void> {
    const { command } = getConfig();
    const parts = command.split(' ');
    const cmd = parts[0];
    const cmdArgs = [...parts.slice(1), '--shutdown'];

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const cwd = workspaceFolder || process.env.HOME || process.cwd();

    outputChannel.appendLine(`Running: ${cmd} ${cmdArgs.join(' ')}`);

    return new Promise((resolve) => {
        const shutdownProcess = child_process.spawn(cmd, cmdArgs, {
            shell: true,
            cwd,
            env: { ...process.env }
        });

        shutdownProcess.stdout?.on('data', (data: Buffer) => {
            outputChannel.append(data.toString());
        });

        shutdownProcess.stderr?.on('data', (data: Buffer) => {
            outputChannel.append(data.toString());
        });

        shutdownProcess.on('close', (code) => {
            outputChannel.appendLine(`Shutdown command exited with code ${code}`);
            resolve();
        });

        shutdownProcess.on('error', (err) => {
            outputChannel.appendLine(`Shutdown command failed: ${err.message}`);
            resolve();
        });

        // Timeout after 5 seconds
        setTimeout(() => {
            shutdownProcess.kill();
            resolve();
        }, 5000);
    });
}

async function getDefaultRoom(baseUrl: string): Promise<string | null> {
    try {
        const response = await fetch(`${baseUrl}/api/rooms/default`);
        if (response.ok) {
            const data = await response.json() as { roomId: string | null };
            return data.roomId;
        }
    } catch (err) {
        outputChannel.appendLine(`Failed to get default room: ${err}`);
    }
    return null;
}

async function uploadFile(filePath: string, baseUrl: string): Promise<string | null> {
    const fileName = path.basename(filePath);
    outputChannel.appendLine(`Uploading ${fileName} to ZnDraw...`);

    try {
        const fs = await import('fs');
        const fileContent = fs.readFileSync(filePath);

        const formData = new FormData();
        formData.append('file', new Blob([fileContent]), fileName);

        const response = await fetch(`${baseUrl}/api/file-browser/upload`, {
            method: 'POST',
            body: formData
        });

        if (response.ok) {
            const data = await response.json() as { room?: string; roomId?: string };
            const roomId = data.room || data.roomId;
            outputChannel.appendLine(`Uploaded ${fileName} successfully to room: ${roomId}`);
            return roomId || null;
        } else {
            outputChannel.appendLine(`Upload failed: ${response.statusText}`);
        }
    } catch (err) {
        outputChannel.appendLine(`Upload error: ${err}`);
    }
    return null;
}

function openLoadingWebview(fileName: string): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
        'zndraw',
        `ZnDraw: ${fileName}`,
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    panel.webview.html = getLoadingContent(fileName);
    outputChannel.appendLine(`Opened loading webview for: ${fileName}`);

    return panel;
}

function updateWebviewToRoom(panel: vscode.WebviewPanel, roomId: string): void {
    const { baseUrl } = getConfig();
    const url = `${baseUrl}/rooms/${roomId}`;

    panel.title = `ZnDraw: ${roomId}`;
    panel.webview.html = getWebviewContent(url);

    // Track in our map
    webviewPanels.set(roomId, panel);
    panel.onDidDispose(() => {
        webviewPanels.delete(roomId);
    });

    outputChannel.appendLine(`Updated webview to room: ${roomId}`);
}

function getLoadingContent(fileName: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ZnDraw - Loading</title>
    <style>
        body, html {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            background: #1e1e1e;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #ccc;
        }
        .spinner {
            width: 50px;
            height: 50px;
            border: 4px solid #333;
            border-top: 4px solid #007acc;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-bottom: 20px;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        .filename {
            font-size: 14px;
            color: #888;
            margin-top: 10px;
        }
    </style>
</head>
<body>
    <div class="spinner"></div>
    <div>Starting ZnDraw server...</div>
    <div class="filename">${fileName}</div>
</body>
</html>`;
}

async function openOrUpdateWebview(roomId?: string): Promise<void> {
    const { baseUrl } = getConfig();

    // If no roomId provided, try to get the default room
    if (!roomId) {
        roomId = await getDefaultRoom(baseUrl) || undefined;
    }

    // Use a key for the panel map (roomId or 'default')
    const panelKey = roomId || 'default';

    // Construct the URL
    const url = roomId ? `${baseUrl}/rooms/${roomId}` : baseUrl;

    // Check if panel for this room already exists
    const existingPanel = webviewPanels.get(panelKey);
    if (existingPanel) {
        existingPanel.reveal();
        outputChannel.appendLine(`Revealed existing webview for: ${panelKey}`);
        return;
    }

    // Create new webview panel for this room
    const panel = vscode.window.createWebviewPanel(
        'zndraw',
        roomId ? `ZnDraw: ${roomId}` : 'ZnDraw',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    panel.webview.html = getWebviewContent(url);
    outputChannel.appendLine(`Opened new webview for room: ${panelKey} at ${url}`);

    // Store panel in map
    webviewPanels.set(panelKey, panel);

    // Remove from map when disposed
    panel.onDidDispose(() => {
        webviewPanels.delete(panelKey);
        outputChannel.appendLine(`Closed webview for room: ${panelKey}`);
    });
}

function getWebviewContent(url: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ZnDraw</title>
    <style>
        body, html {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background: #1e1e1e;
        }
        iframe {
            width: 100%;
            height: 100%;
            border: none;
        }
        .loading {
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            height: 100%;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #888;
        }
        .spinner {
            width: 40px;
            height: 40px;
            border: 3px solid #333;
            border-top: 3px solid #888;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-bottom: 16px;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <iframe src="${url}" id="zndraw-frame"></iframe>
    <script>
        const iframe = document.getElementById('zndraw-frame');
        let retryCount = 0;
        const maxRetries = 30;

        iframe.onerror = () => {
            if (retryCount < maxRetries) {
                retryCount++;
                document.body.innerHTML = '<div class="loading"><div class="spinner"></div><div>Connecting to ZnDraw... (attempt ' + retryCount + ')</div></div>';
                setTimeout(() => location.reload(), 2000);
            }
        };
    </script>
</body>
</html>`;
}

function updateStatusBar() {
    const { baseUrl, isRemote } = getConfig();

    if (serverProcess) {
        statusBarItem.text = '$(circle-filled) ZnDraw';
        statusBarItem.tooltip = isRemote
            ? `ZnDraw connected to ${baseUrl} (click to stop)`
            : `ZnDraw running at ${baseUrl} (click to stop)`;
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = '$(circle-outline) ZnDraw';
        statusBarItem.tooltip = isRemote
            ? `Click to connect to ${baseUrl}`
            : 'ZnDraw stopped (click to start)';
        statusBarItem.backgroundColor = undefined;
    }
}

export async function deactivate() {
    if (serverProcess) {
        // Run zndraw --shutdown for graceful cleanup
        await runZndrawShutdown();

        // Force kill if still running
        if (serverProcess) {
            serverProcess.kill('SIGTERM');
            serverProcess = null;
        }
    }
}
