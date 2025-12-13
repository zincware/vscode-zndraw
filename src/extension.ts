import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PythonExtension } from "@vscode/python-extension";
import * as vscode from "vscode";

let serverProcess: child_process.ChildProcess | null = null;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;
const webviewPanels: Map<string, vscode.WebviewPanel> = new Map();

export function activate(context: vscode.ExtensionContext) {
    extensionContext = context;
    outputChannel = vscode.window.createOutputChannel("ZnDraw");

    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100,
    );
    statusBarItem.command = "zndraw.toggleServer";
    updateStatusBar();
    statusBarItem.show();

    const openFileCmd = vscode.commands.registerCommand(
        "zndraw.openFile",
        async (uri: vscode.Uri) => {
            if (!uri) {
                vscode.window.showErrorMessage("No file selected");
                return;
            }
            await startServerWithFile(uri.fsPath);
        },
    );

    const startServerCmd = vscode.commands.registerCommand(
        "zndraw.startServer",
        async () => {
            await startServer();
        },
    );

    const stopServerCmd = vscode.commands.registerCommand(
        "zndraw.stopServer",
        async () => {
            await stopServer();
        },
    );

    const openViewerCmd = vscode.commands.registerCommand(
        "zndraw.openViewer",
        async () => {
            await openOrUpdateWebview();
        },
    );

    const toggleServerCmd = vscode.commands.registerCommand(
        "zndraw.toggleServer",
        async () => {
            if (serverProcess) {
                await stopServer();
            } else {
                await startServer();
            }
        },
    );

    context.subscriptions.push(
        openFileCmd,
        startServerCmd,
        stopServerCmd,
        openViewerCmd,
        toggleServerCmd,
        outputChannel,
        statusBarItem,
    );

    // Auto-start if configured
    const config = vscode.workspace.getConfiguration("zndraw");
    if (config.get<boolean>("autoStart")) {
        startServer();
    }
}

function getConfig() {
    const config = vscode.workspace.getConfiguration("zndraw");
    const serverUrl = config.get<string>("serverUrl", "");
    const port = config.get<number>("port", 5000);

    return {
        command: config.get<string>("command", "zndraw"),
        port,
        serverUrl,
        extraArgs: config.get<string[]>("extraArgs", []),
        isRemote: serverUrl.length > 0,
        baseUrl: serverUrl || `http://localhost:${port}`,
    };
}

async function getActivePythonPath(): Promise<string | undefined> {
    try {
        const pythonApi = await PythonExtension.api();
        const environmentPath =
            pythonApi.environments.getActiveEnvironmentPath();

        if (!environmentPath) {
            outputChannel.appendLine("No active Python environment found");
            return undefined;
        }

        const environment =
            await pythonApi.environments.resolveEnvironment(environmentPath);
        if (environment?.executable?.uri) {
            return environment.executable.uri.fsPath;
        }

        // Fallback to the path directly if executable URI not available
        return environmentPath.path;
    } catch (err) {
        outputChannel.appendLine(`Failed to get Python environment: ${err}`);
        return undefined;
    }
}

async function startServer(): Promise<void> {
    if (serverProcess) {
        vscode.window.showInformationMessage("ZnDraw is already running");
        return;
    }

    const { command, port, extraArgs, isRemote, serverUrl } = getConfig();

    let args: string[];
    if (isRemote) {
        // Connect to remote server
        args = ["--connect", serverUrl, ...extraArgs];
    } else {
        // Start local server
        args = ["--port", port.toString(), "--no-browser", ...extraArgs];
    }

    await spawnServer(command, args);
}

async function startServerWithFile(filePath: string): Promise<void> {
    const { command, port, extraArgs, isRemote, serverUrl, baseUrl } =
        getConfig();

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
        args = [filePath, "--connect", serverUrl, ...extraArgs];
    } else {
        // Start local server with file
        args = [
            filePath,
            "--port",
            port.toString(),
            "--no-browser",
            ...extraArgs,
        ];
    }

    await spawnServer(command, args, filePath);
}

async function spawnServer(
    command: string,
    args: string[],
    filePath?: string,
): Promise<void> {
    // Use workspace folder or home directory as cwd so zndraw-data is writable
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const cwd = workspaceFolder || process.env.HOME || process.cwd();

    outputChannel.clear();
    outputChannel.show();

    // Open loading webview immediately if we have a file
    let loadingPanel: vscode.WebviewPanel | undefined;
    if (filePath) {
        loadingPanel = openLoadingWebview(path.basename(filePath));
    }

    // Determine command and arguments
    const parts = command.split(" ");
    let cmd = parts[0];
    const cmdArgs = [...parts.slice(1), ...args];

    // If Python environment is available, run command from its bin directory
    const pythonPath = await getActivePythonPath();
    if (pythonPath) {
        const binDir = path.dirname(pythonPath);
        cmd = path.join(binDir, cmd);
        outputChannel.appendLine(`Using Python environment: ${binDir}`);
    }

    outputChannel.appendLine(`Starting ZnDraw: ${cmd} ${cmdArgs.join(" ")}`);
    outputChannel.appendLine(`Working directory: ${cwd}`);

    serverProcess = child_process.spawn(cmd, cmdArgs, {
        shell: true,
        cwd,
        env: { ...process.env },
    });

    serverProcess.stdout?.on("data", (data: Buffer) => {
        const text = data.toString();
        outputChannel.append(text);

        // Check if server is ready and parse room URL
        if (text.includes("Running on") || text.includes("localhost")) {
            const { port } = getConfig();
            vscode.window.showInformationMessage(
                `ZnDraw running on http://localhost:${port}`,
            );
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

    serverProcess.stderr?.on("data", (data: Buffer) => {
        outputChannel.append(data.toString());
    });

    serverProcess.on("close", (code) => {
        outputChannel.appendLine(`ZnDraw server exited with code ${code}`);
        serverProcess = null;
        updateStatusBar();
    });

    serverProcess.on("error", (err) => {
        outputChannel.appendLine(`Failed to start ZnDraw: ${err.message}`);
        vscode.window.showErrorMessage(
            `Failed to start ZnDraw: ${err.message}. Make sure zndraw is installed in your Python environment or uvx is available.`,
        );
        serverProcess = null;
        updateStatusBar();
    });

    updateStatusBar();

    // Aggressively poll for default room
    if (loadingPanel) {
        pollForRoom(loadingPanel);
    }
}

async function pollForRoom(
    panel: vscode.WebviewPanel,
    attempt: number = 0,
): Promise<void> {
    const maxAttempts = 30;
    const intervalMs = 500; // Poll every 500ms

    if (attempt >= maxAttempts || !serverProcess) {
        outputChannel.appendLine(
            `Room polling stopped after ${attempt} attempts`,
        );
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
        vscode.window.showInformationMessage("ZnDraw server is not running");
        return;
    }

    outputChannel.appendLine("Stopping ZnDraw server...");

    // Use zndraw --shutdown for graceful shutdown
    await runZndrawShutdown();

    // Force kill the process if still running
    if (serverProcess) {
        serverProcess.kill("SIGTERM");

        // Force kill after timeout
        setTimeout(() => {
            if (serverProcess) {
                serverProcess.kill("SIGKILL");
                serverProcess = null;
                updateStatusBar();
            }
        }, 3000);
    }

    serverProcess = null;
    updateStatusBar();
    vscode.window.showInformationMessage("ZnDraw server stopped");
}

async function runZndrawShutdown(): Promise<void> {
    const { command } = getConfig();

    // If Python environment is available, run command from its bin directory
    let cmd = command;
    const pythonPath = await getActivePythonPath();
    if (pythonPath) {
        const binDir = path.dirname(pythonPath);
        cmd = path.join(binDir, command);
    }
    const cmdArgs = ["--shutdown"];

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const cwd = workspaceFolder || process.env.HOME || process.cwd();

    outputChannel.appendLine(`Running: ${cmd} ${cmdArgs.join(" ")}`);

    return new Promise((resolve) => {
        const shutdownProcess = child_process.spawn(cmd, cmdArgs, {
            shell: true,
            cwd,
            env: { ...process.env },
        });

        shutdownProcess.stdout?.on("data", (data: Buffer) => {
            outputChannel.append(data.toString());
        });

        shutdownProcess.stderr?.on("data", (data: Buffer) => {
            outputChannel.append(data.toString());
        });

        shutdownProcess.on("close", (code) => {
            outputChannel.appendLine(
                `Shutdown command exited with code ${code}`,
            );
            resolve();
        });

        shutdownProcess.on("error", (err) => {
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
            const data = (await response.json()) as { roomId: string | null };
            return data.roomId;
        }
    } catch (err) {
        outputChannel.appendLine(`Failed to get default room: ${err}`);
    }
    return null;
}

async function uploadFile(
    filePath: string,
    baseUrl: string,
): Promise<string | null> {
    const fileName = path.basename(filePath);
    outputChannel.appendLine(`Uploading ${fileName} to ZnDraw...`);

    try {
        const fs = await import("node:fs");
        const fileContent = fs.readFileSync(filePath);

        const formData = new FormData();
        formData.append("file", new Blob([fileContent]), fileName);

        const response = await fetch(`${baseUrl}/api/file-browser/upload`, {
            method: "POST",
            body: formData,
        });

        if (response.ok) {
            const data = (await response.json()) as {
                room?: string;
                roomId?: string;
            };
            const roomId = data.room || data.roomId;
            outputChannel.appendLine(
                `Uploaded ${fileName} successfully to room: ${roomId}`,
            );
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
        "zndraw",
        `ZnDraw: ${fileName}`,
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
        },
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
    const htmlPath = path.join(
        extensionContext.extensionPath,
        "media",
        "loading.html",
    );
    const html = fs.readFileSync(htmlPath, "utf8");
    return html.replace("{{fileName}}", fileName);
}

async function openOrUpdateWebview(roomId?: string): Promise<void> {
    const { baseUrl } = getConfig();

    // If no roomId provided, try to get the default room
    if (!roomId) {
        roomId = (await getDefaultRoom(baseUrl)) || undefined;
    }

    // Use a key for the panel map (roomId or 'default')
    const panelKey = roomId || "default";

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
        "zndraw",
        roomId ? `ZnDraw: ${roomId}` : "ZnDraw",
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
        },
    );

    panel.webview.html = getWebviewContent(url);
    outputChannel.appendLine(
        `Opened new webview for room: ${panelKey} at ${url}`,
    );

    // Store panel in map
    webviewPanels.set(panelKey, panel);

    // Remove from map when disposed
    panel.onDidDispose(() => {
        webviewPanels.delete(panelKey);
        outputChannel.appendLine(`Closed webview for room: ${panelKey}`);
    });
}

function getWebviewContent(url: string): string {
    const htmlPath = path.join(
        extensionContext.extensionPath,
        "media",
        "viewer.html",
    );
    const html = fs.readFileSync(htmlPath, "utf8");
    return html.replace("{{url}}", url);
}

function updateStatusBar() {
    const { baseUrl, isRemote } = getConfig();

    if (serverProcess) {
        statusBarItem.text = "$(circle-filled) ZnDraw";
        statusBarItem.tooltip = isRemote
            ? `ZnDraw connected to ${baseUrl} (click to stop)`
            : `ZnDraw running at ${baseUrl} (click to stop)`;
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = "$(circle-outline) ZnDraw";
        statusBarItem.tooltip = isRemote
            ? `Click to connect to ${baseUrl}`
            : "ZnDraw stopped (click to start)";
        statusBarItem.backgroundColor = undefined;
    }
}

export async function deactivate() {
    if (serverProcess) {
        // Run zndraw --shutdown for graceful cleanup
        await runZndrawShutdown();

        // Force kill if still running
        if (serverProcess) {
            serverProcess.kill("SIGTERM");
            serverProcess = null;
        }
    }
}
