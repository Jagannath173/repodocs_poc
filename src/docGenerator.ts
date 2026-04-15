import * as vscode from "vscode";
import * as path from "path";
import { runCopilotInference } from "./pythonRunner";

export async function generateDocumentation() {
  const editor = vscode.window.activeTextEditor;
  const fileName = editor ? path.basename(editor.document.fileName) : "Code Snippet";
  
  const prompt = `Act as an expert software architect and technical lead. Provide a comprehensive, high-level technical analysis of the following logic in "${fileName}". 
Your analysis MUST include:
1. **Executive Summary**: A concise 2-3 sentence overview of the component's role.
2. **Primary Purpose**: Detailed explanation of what this code achieves and why it exists.
3. **Key Data Structures & Logic Flow**: A deep dive into the main classes, functions, and the sequence of operations.
4. **Architectural Patterns & Design**: Identification of any design patterns (e.g., Factory, Observer, Singleton) and adherence to SOLID principles.
5. **Technical Observations**: Note any potential optimizations, security considerations, or notable implementation details.

Format your response using professional Markdown with clear headings and bullet points.`;

  const result = await streamFromCopilot(prompt, true);
  if (result) vscode.window.showInformationMessage("Technical analysis complete!");
}

export async function generateFullRepoDocumentation() {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return;
  
  const files = await vscode.workspace.findFiles("**/*.{ts,js,py}", "**/node_modules/**");
  const fileList = files.map(f => path.basename(f.fsPath)).join(", ");
  
  const prompt = `System Architecture Overview: You are looking at a project containing these primary files: [${fileList}]. 
Analyze the file names and structure to explain the overall architectural pattern (e.g., MVC, Microservices, Layered) and the high-level business goal of this repository. 
Provide a roadmap of how these files likely interact.`;
  
  const result = await streamFromCopilot(prompt, false);
  if (result) vscode.window.showInformationMessage("Full repo analysis complete!");
}

import { extensionContext } from "./extension";

async function streamFromCopilot(promptPrefix: string, useSelection: boolean): Promise<boolean> {
  // ✅ AUTHENTICATION GUARD: Block execution immediately if not authenticated
  const storedSessionId = extensionContext.globalState.get<string>("copilot_session_id");
  const storedAccessToken = extensionContext.globalState.get<string>("copilot_access_token_override");
  if (!storedSessionId && !storedAccessToken) {
    vscode.window.showErrorMessage(
      "🔒 Not authenticated. Please log in to GitHub Copilot first before generating docs.",
      "Login to Copilot"
    ).then(selection => {
      if (selection === "Login to Copilot") {
        vscode.commands.executeCommand("internalPythonRunner.authenticateCopilot");
      }
    });
    return false;
  }

  const editor = vscode.window.activeTextEditor;
  
  let content = "";
  if (editor) {
    if (useSelection && !editor.selection.isEmpty) {
        content = editor.document.getText(editor.selection);
    } else {
        content = editor.document.getText();
    }
  }

  if (!content) {
    vscode.window.showWarningMessage("No code found to analyze! Open a file first.");
    return false;
  }

  const fileName = editor ? path.basename(editor.document.fileName) : "Analysis";
  const finalPrompt = `${promptPrefix}\n\n### Source Code (File: ${fileName}):\n\`\`\`\n${content}\n\`\`\``;
  
  const header = `# AI Technical Analysis: ${fileName}\n\n*Generated via GitHub Copilot Proxy*\n\n---\n\n> 💡 **Status:** Analyzing code structure and generating insights...\n\n`;
  const doc = await vscode.workspace.openTextDocument({ content: header, language: "markdown" });
  const docEditor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);

  const output = vscode.window.createOutputChannel("Internal Python Runner");
  try {
    let authErrorOccurred = false;
    let editQueue = Promise.resolve();
    let hasStartedStreaming = false;
    
    await runCopilotInference(extensionContext, finalPrompt, (data) => {
      output.append(data);

      const lines = data.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        
        if (trimmed.includes("Error: No active Copilot session")) {
            authErrorOccurred = true;
        }

        if (trimmed.startsWith("data: ")) {
            const jsonStr = trimmed.substring(6).trim();
            if (jsonStr === "[DONE]") {
                // Remove the status line when done
                editQueue = editQueue.then(async () => {
                    const fullText = doc.getText();
                    const statusLine = "> 💡 **Status:** Analyzing code structure and generating insights...\n\n";
                    const newText = fullText.replace(statusLine, "> ✅ **Analysis Complete.**\n\n");
                    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(fullText.length));
                    await docEditor.edit(eb => eb.replace(fullRange, newText));
                });
                return;
            }
            try {
                const json = JSON.parse(jsonStr);
                const text = json.choices?.[0]?.delta?.content || 
                             json.choices?.[0]?.message?.content || 
                             json.choices?.[0]?.text;
                
                if (text) {
                  if (!hasStartedStreaming) {
                      hasStartedStreaming = true;
                  }
                  editQueue = editQueue.then(() => {
                    return docEditor.edit(eb => {
                        const lp = doc.lineCount - 1;
                        const lastLine = doc.lineAt(lp);
                        eb.insert(new vscode.Position(lp, lastLine.text.length), text);
                    }, { undoStopBefore: false, undoStopAfter: false }).then(() => {});
                  });
                }
            } catch (e) { 
                output.appendLine(`[DocGen] JSON Parse Error: ${e}`);
            }
        } else if (trimmed.includes("Error:") || trimmed.includes("Exception:")) {
                editQueue = editQueue.then(() => {
                  return docEditor.edit(eb => {
                      const lp = doc.lineCount - 1;
                      eb.insert(new vscode.Position(lp, doc.lineAt(lp).text.length), `\n\n**System Error:** ${trimmed}\n`);
                  }).then(() => {});
                });
        }
      }
    });

    await editQueue;

    if (authErrorOccurred) {
        vscode.window.showErrorMessage("GitHub Copilot session not found. Please authenticate first.", "Authenticate").then(selection => {
            if (selection === "Authenticate") {
                vscode.commands.executeCommand("internalPythonRunner.authenticateCopilot");
            }
        });
        return false;
    }

    return true;
  } catch (error: any) {
    vscode.window.showErrorMessage(`Copilot Error: ${error.message}`);
    return false;
  }
}

