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

2. Enable automatic extension updates for your macOS account.

   ```sh
   python3 scripts/update_extension.py install
   ```

   The installer prints the permanent extension directory, `~/.local/share/codex-chrome-cli/task-extension`. In the Chrome profile you want Codex to use, open `chrome://extensions`. Turn on **Developer mode**, choose **Load unpacked**, and select that directory. Chrome should show **Playwright — task groups (local)**. This build shares an extension ID with the Microsoft Playwright extension from the Chrome Web Store. If you already use the store version, you can load this build in a separate profile. The official ChatGPT extension has its own ID and can stay enabled.

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

## Automatic extension updates

A per-user LaunchAgent checks this GitHub repository for a new stable release every four hours while you are logged in. It verifies the ZIP against the SHA-256 digest from GitHub and checks the extension ID and version. If Chrome is running, it stages the update. Once a minute the agent checks whether Chrome has fully quit. It then swaps the extension directory atomically and keeps the previous version in `~/.local/share/codex-chrome-cli/task-updates/previous`. Chrome loads the updated files on its next launch. New required permissions need a manual update.

For a previous ZIP or repository installation, run the installer once. If Chrome already loads the permanent directory printed by the installer, keep that registration. If you previously loaded a different directory, load the permanent directory once and check the token in step 3. Future releases use the same directory and extension ID. The updater manages the Chrome extension only. The MCP server and the updater script come from the repository checkout.

To check immediately, run `python3 scripts/update_extension.py check`. If it reports a staged update, quit Chrome and rerun the command to apply it immediately, or leave Chrome closed for a minute. To disable scheduled checks, run `python3 scripts/update_extension.py disable`. The installed extension stays available.

For manual installation, download the extension ZIP from the [latest release](https://github.com/NikoVonLas/codex-chrome-task-groups/releases/latest), extract it into a permanent folder, and choose that folder with **Load unpacked**. Then complete steps 3–5.

## Troubleshooting

- **Codex cannot find `browser_start_task`.** Check the registration with `codex mcp get chrome-cli` and open a new Codex CLI session. If you moved the clone or changed the Node executable path, repeat step 4.
- **Chrome reports `Invalid token provided`.** Check which profile Chrome is using. To replace a stale token, delete `~/.codex-chrome-task-groups/extension-token` and repeat step 3 using that profile.
- **Local HTML files do not open.** In the extension details in Chrome, turn on **Allow access to file URLs**. When registering the server, add `--allow-unrestricted-file-access` after the path to `start.mjs`. This flag also permits file operations outside the workspace.
- **Task tabs close after a pause.** The connector closes its task tabs after 120 seconds of inactivity. The timer pauses while an operation is running. Use `browser_start_task` to begin a new task.

To uninstall, disable automatic updates as described above, then run `codex mcp remove chrome-cli` and remove the extension from `chrome://extensions`.

## Publishing a release

Set the release version in the package metadata, extension manifest, and MCP server info. Publish a GitHub release with the matching `vX.Y.Z` tag. GitHub Actions runs the tests and attaches `chrome-task-groups-X.Y.Z.zip` to the release. The ZIP contains the unpacked Chrome extension and its license notices. The MCP server is available in the source archive and repository.

## Development and licensing

```sh
node --test extension.test.mjs lifecycle.test.mjs
python3 -m unittest discover -s scripts
```

The tests cover tab ownership, group creation, and cleanup when a task ends, the client disconnects, or Chrome returns an error. The `extension` directory contains the unpacked build. The local changes update the manifest name and group handling in `lib/background.mjs`.

The extension is based on Microsoft Playwright. npm installs Microsoft’s Playwright MCP server. [Playwright](https://github.com/microsoft/playwright) · [Playwright MCP](https://github.com/microsoft/playwright-mcp)

The repository includes the applicable license and third-party notices. [License](LICENSE) · [Notice](NOTICE) · [Third-party notices](ThirdPartyNotices.txt)
