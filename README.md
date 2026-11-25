# Chrome Task Groups for Codex CLI

Control Google Chrome from Codex CLI on macOS. Each task gets a named group of background tabs. When a task finishes, the connector ungroups and closes the tabs it owns. Other tasks can keep their groups open.

The connector runs on the same Mac as Chrome and Codex CLI. It includes a modified Microsoft Playwright Extension 0.5.0 and a local server that wraps Playwright MCP 0.0.85. The ChatGPT desktop app uses a separate OpenAI integration for `@Chrome` and its side chat.

## Install on macOS

You need Google Chrome, Git, Node.js 22 with npm, Python 3, and a configured Codex CLI. Run the commands below in Terminal under your own account.

1. Clone the repository into a directory you plan to keep and install the dependencies.

   ```sh
   git clone https://github.com/NikoVonLas/codex-chrome-task-groups.git
   cd codex-chrome-task-groups
   npm ci --ignore-scripts --no-audit --no-fund
   ```

2. In the Chrome profile you want Codex to use, open `chrome://extensions`. Turn on **Developer mode**, choose **Load unpacked**, and select the `extension` directory in the clone. Chrome should show **Playwright — task groups (local)**. This build shares an extension ID with the Microsoft Playwright extension from the Chrome Web Store. If you already use the store version, you can load this build in a separate profile. The official ChatGPT extension has its own ID and can stay enabled.

3. Click **Playwright — task groups (local)** in Chrome’s extensions menu. On its status page, click the copy button next to `PLAYWRIGHT_MCP_EXTENSION_TOKEN`. Run the following command in Terminal, paste the copied text at the hidden prompt, and press Return.

   ```sh
   python3 setup-token.py
   ```

   Each profile has its own token. The setup script stores it on this Mac at `~/.codex-chrome-task-groups/extension-token` with file mode `0600`. The token allows repeated access to the browser, including signed-in sites. The extension requests debugger access and access to all sites. Use a separate Chrome profile to limit which accounts are available to Codex.

4. Register the server with Codex CLI.

   ```sh
   codex mcp add chrome-cli -- "$(command -v node)" "$PWD/start.mjs"
   codex mcp get chrome-cli
   ```

   The server uses the `Default` Chrome profile unless you specify another one. To find the directory name of your profile, open `chrome://version` and read the last component of **Profile Path**. For a directory named `Profile 1`, use this registration command.

   ```sh
   codex mcp add chrome-cli --env 'CHROME_PROFILE_DIR=Profile 1' -- "$(command -v node)" "$PWD/start.mjs"
   ```

5. Open a new Codex CLI session and try this request.

   > Use chrome-cli to start a task named “Connection check”. Open https://example.com in a new tab, read the page title, and finish the task.

   The expected title is **Example Domain**. After `browser_finish`, the session should report zero remaining tabs.

## Troubleshooting

- **Codex cannot find `browser_start_task`.** Check the registration with `codex mcp get chrome-cli` and open a new Codex CLI session. If you moved the clone or changed the Node executable path, repeat step 4.
- **Chrome reports `Invalid token provided`.** Check which profile Chrome is using. To replace a stale token, delete `~/.codex-chrome-task-groups/extension-token` and repeat step 3 using that profile.
- **Local HTML files do not open.** In the extension details in Chrome, turn on **Allow access to file URLs**. When registering the server, add `--allow-unrestricted-file-access` after the path to `start.mjs`. This flag also permits file operations outside the workspace.
- **Task tabs close after a pause.** The connector closes its task tabs after 120 seconds of inactivity. The timer pauses while an operation is running. Use `browser_start_task` to begin a new task.

To uninstall, run `codex mcp remove chrome-cli` and remove the extension from `chrome://extensions`.

## Development and licensing

```sh
node --test extension.test.mjs lifecycle.test.mjs
```

The tests cover tab ownership, group creation, and cleanup when a task ends, the client disconnects, or Chrome returns an error. The `extension` directory contains the unpacked build. The local changes update the manifest name and group handling in `lib/background.mjs`.

The extension is based on Microsoft Playwright. npm installs Microsoft’s Playwright MCP server. [Playwright](https://github.com/microsoft/playwright) · [Playwright MCP](https://github.com/microsoft/playwright-mcp)

The repository includes the applicable license and third-party notices. [License](LICENSE) · [Notice](NOTICE) · [Third-party notices](ThirdPartyNotices.txt)
