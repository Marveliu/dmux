export const meta = { title: 'Configuration' };

export function render() {
  return `
    <h1>Configuration</h1>
    <p class="lead">dmux uses a layered configuration system with global, team, and project-level settings. Project settings override global settings, and global settings override optional team defaults committed in the repo.</p>

    <h2>Configuration Files</h2>
    <table>
      <thead>
        <tr><th>File</th><th>Scope</th><th>Purpose</th></tr>
      </thead>
      <tbody>
        <tr><td><code>~/.dmux.global.json</code></td><td>Global</td><td>Default settings for all projects</td></tr>
        <tr><td><code>.dmux.defaults.json</code></td><td>Team</td><td>Repo-committed defaults shared across the project</td></tr>
        <tr><td><code>.dmux/settings.json</code></td><td>Project</td><td>Project-specific overrides</td></tr>
        <tr><td><code>.dmux/dmux.config.json</code></td><td>Project</td><td>Pane tracking (managed by dmux)</td></tr>
      </tbody>
    </table>

    <h2>Available Settings</h2>

    <h3><code>enableAutopilotByDefault</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>boolean</code></td></tr>
        <tr><td><strong>Default</strong></td><td><code>true</code></td></tr>
        <tr><td><strong>Description</strong></td><td>Automatically accept options when no risk is detected for new panes. When enabled, agents will run with less user intervention.</td></tr>
      </tbody>
    </table>

    <h3><code>enableGoalModeByDefault</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>boolean</code></td></tr>
        <tr><td><strong>Default</strong></td><td><code>false</code></td></tr>
        <tr><td><strong>Description</strong></td><td>Start new panes in goal mode when the selected agent supports it. The new-pane prompt popup also includes a per-pane goal-mode checkbox.</td></tr>
      </tbody>
    </table>

    <h3><code>enableNotifications</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>boolean</code></td></tr>
        <tr><td><strong>Default</strong></td><td><code>true</code></td></tr>
        <tr><td><strong>Description</strong></td><td>Allow dmux attention notifications, including native macOS alerts and same-window attention flashes. Disable this for a completely quiet attention-notification mode.</td></tr>
      </tbody>
    </table>

    <h3><code>permissionMode</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>'' | 'plan' | 'acceptEdits' | 'bypassPermissions'</code></td></tr>
        <tr><td><strong>Default</strong></td><td><code>'bypassPermissions'</code></td></tr>
        <tr><td><strong>Description</strong></td><td>Controls the permission flags dmux passes to launched agents. Use empty string to defer to each agent's own defaults.</td></tr>
      </tbody>
    </table>

    <h3><code>defaultAgent</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>AgentName | ''</code></td></tr>
        <tr><td><strong>Default</strong></td><td><code>''</code> (ask each time)</td></tr>
        <tr><td><strong>Description</strong></td><td>Preselect this agent at <code>1x</code> in the new-pane agent chooser and use it for non-interactive pane creation. Set it to any supported agent ID such as <code>claude</code>, <code>codex</code>, <code>grok</code>, or <code>gemini</code>. Use an empty string to start from the first available agent.</td></tr>
      </tbody>
    </table>

    <h3><code>enabledAgents</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>AgentName[]</code></td></tr>
        <tr><td><strong>Default</strong></td><td><code>default-enabled registry entries</code></td></tr>
        <tr><td><strong>Description</strong></td><td>Controls which agents appear in the new-pane selection popup. Use the settings UI to enable or disable agents per scope.</td></tr>
      </tbody>
    </table>

    <h3><code>enabledNotificationSounds</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>NotificationSoundId[]</code></td></tr>
        <tr><td><strong>Default</strong></td><td><code>['default-system-sound']</code></td></tr>
        <tr><td><strong>Description</strong></td><td>Select which macOS notification sounds dmux randomizes between for background attention notifications. If the list is empty or invalid, dmux falls back to the default system sound.</td></tr>
      </tbody>
    </table>

    <h3><code>inferencePrimary</code> / <code>inferenceBackup</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>{ providerId, modelId, ...customConnectionFields } | null</code></td></tr>
        <tr><td><strong>Default</strong></td><td>Not configured; <code>inferenceBackup</code> is optional</td></tr>
        <tr><td><strong>Description</strong></td><td>The provider/model pair used for dmux inference and its optional failover. Use the Inference Providers settings flow so model IDs come from the provider catalog. Credentials are not stored in these objects.</td></tr>
      </tbody>
    </table>

    <h3><code>useTmuxHooks</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>boolean</code></td></tr>
        <tr><td><strong>Default</strong></td><td><code>false</code></td></tr>
        <tr><td><strong>Description</strong></td><td>Use tmux hooks for event-driven pane updates instead of polling. Lower CPU usage but requires tmux hook support.</td></tr>
      </tbody>
    </table>

    <h3><code>baseBranch</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>string</code></td></tr>
        <tr><td><strong>Default</strong></td><td><code>''</code> (current HEAD)</td></tr>
        <tr><td><strong>Description</strong></td><td>Branch to create new worktrees from. Leave empty to use the current HEAD. The branch must exist in the repository.</td></tr>
      </tbody>
    </table>

    <h3><code>branchPrefix</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>string</code></td></tr>
        <tr><td><strong>Default</strong></td><td><code>''</code> (no prefix)</td></tr>
        <tr><td><strong>Description</strong></td><td>Prefix for new branch names. For example, setting this to <code>feat/</code> will create branches like <code>feat/fix-auth</code>. The worktree directory name stays flat (just the slug).</td></tr>
      </tbody>
    </table>

    <h3><code>promptForGitOptionsOnCreate</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>boolean</code></td></tr>
        <tr><td><strong>Default</strong></td><td><code>false</code></td></tr>
        <tr><td><strong>Description</strong></td><td>When enabled, the new-pane popup asks for optional create-time overrides for base branch and branch/worktree name. Base branch override must match an existing local branch (suggested in most-recently-committed order). These per-pane overrides take precedence over <code>baseBranch</code> and <code>branchPrefix</code>.</td></tr>
      </tbody>
    </table>

    <h3><code>minPaneWidth</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>number</code></td></tr>
        <tr><td><strong>Default</strong></td><td><code>50</code></td></tr>
        <tr><td><strong>Description</strong></td><td>Minimum content-pane width in characters. Used during layout fitting to prevent panes from becoming too narrow. Range: 40–300. This is a global-only setting (project overrides are ignored).</td></tr>
      </tbody>
    </table>

    <h3><code>maxPaneWidth</code></h3>
    <table>
      <tbody>
        <tr><td><strong>Type</strong></td><td><code>number</code></td></tr>
        <tr><td><strong>Default</strong></td><td><code>80</code></td></tr>
        <tr><td><strong>Description</strong></td><td>Maximum content-pane width in characters. Controls when wrapping or spacer logic kicks in. Range: 40–300. This is a global-only setting (project overrides are ignored).</td></tr>
      </tbody>
    </table>

    <h2>Accessing Settings</h2>

    <h3>TUI</h3>
    <p>Press <kbd>s</kbd> to open the settings dialog. You can switch between global and project scope, toggle each setting, choose enabled agents, configure inference providers, and configure macOS attention notification sounds.</p>

    <h3>Manual Editing</h3>
    <p>You can edit the JSON files directly:</p>
    <pre><code data-lang="json">{
  "enableAutopilotByDefault": true,
  "enableGoalModeByDefault": false,
  "enableNotifications": true,
  "permissionMode": "bypassPermissions",
  "defaultAgent": "claude",
  "enabledAgents": ["claude", "codex", "grok", "gemini"],
  "enabledNotificationSounds": ["default-system-sound", "harp"],
  "inferencePrimary": { "providerId": "cerebras", "modelId": "provider-model-id" },
  "inferenceBackup": { "providerId": "openrouter", "modelId": "provider/model-id" },
  "useTmuxHooks": false,
  "baseBranch": "develop",
  "branchPrefix": "feat/",
  "promptForGitOptionsOnCreate": true,
  "minPaneWidth": 50,
  "maxPaneWidth": 80
}</code></pre>
    <p><code>.dmux.defaults.json</code> lives at the repo root and is intended for safe, team-wide defaults that you want in version control. Personal overrides still belong in <code>.dmux/settings.json</code> or <code>~/.dmux.global.json</code>.</p>

    <h2>macOS Attention Notifications</h2>
    <p>On macOS, dmux ships with a native helper that can send attention notifications for background panes. This is progressive enhancement only: dmux continues working on Linux and Windows without it.</p>
    <ul>
      <li>Notifications are only sent for panes that are not currently fully focused</li>
      <li><code>enableNotifications</code> disables native alerts and same-window attention flashes when set to <code>false</code></li>
      <li><code>enabledNotificationSounds</code> controls which sounds are eligible for random selection through macOS notification delivery</li>
      <li>The sidebar and pane borders still show attention state even when native notifications are unavailable</li>
    </ul>

    <h2>Setting Precedence</h2>
    <p>When the same key is defined in multiple places, dmux resolves it in this order:</p>
    <ol>
      <li>Project settings (<code>.dmux/settings.json</code>) — highest priority</li>
      <li>Global settings (<code>~/.dmux.global.json</code>) — fallback</li>
      <li>Team defaults (<code>.dmux.defaults.json</code>) — shared repo baseline</li>
      <li>Built-in defaults — if neither file defines the setting</li>
    </ol>

    <h2>Inference Providers</h2>
    <p>dmux uses one shared inference configuration for smart branch names, automatic terminal names, commit messages, PR summaries, conflict assistance, and pane-state analysis. Press <kbd>s</kbd>, open <strong>Inference Providers</strong>, and search for a provider.</p>

    <h3>Provider and Model Selection</h3>
    <ol>
      <li>Choose a primary provider. dmux detects its standard environment key if one is already set.</li>
      <li>If the key is missing, enter it once. dmux adds a managed export to your shell profile and stores a private <code>0600</code> copy under <code>~/.dmux/</code> so the current process can use it immediately.</li>
      <li>Search and select a model. dmux loads the current catalog from the provider's <code>/models</code> endpoint whenever that endpoint is available.</li>
      <li>Optionally repeat the flow for a backup provider/model. Requests only move to the backup after the primary fails.</li>
    </ol>
    <p>Built-in choices include ChatGPT subscription, Grok Build subscription, OpenRouter, OpenAI, Anthropic, Google Gemini, xAI, Groq, Cerebras, DeepSeek, Mistral, Together, Fireworks, Perplexity, Cohere, Vercel AI Gateway, and Hugging Face. Choose <strong>Custom OpenAI-compatible</strong> for another service; provide its base URL and environment variable name. If a service does not expose a model catalog, dmux lets you enter a model ID manually.</p>

    <h3>ChatGPT Subscription</h3>
    <p>Choose <strong>ChatGPT subscription</strong> to use a Codex/ChatGPT plan instead of usage-based API billing. dmux invokes the installed Codex CLI's supported login flow, leaves credential storage and token refresh to Codex, and reads the available model catalog from Codex app-server.</p>
    <p>Choose <strong>Grok Build subscription</strong> to use a SpaceXAI plan instead of the usage-billed xAI API provider. dmux invokes the installed Grok Build CLI's OAuth flow, leaves credential storage and refresh to that CLI, and reads its current model catalog from <code>grok models</code>.</p>
    <pre><code data-lang="bash">codex login
codex login status</code></pre>
    <p>ChatGPT inference requires the Codex CLI. An OpenAI Platform API key is a separate provider choice and uses <code>OPENAI_API_KEY</code>.</p>

    <h3>How It's Used</h3>
    <table>
      <thead>
        <tr><th>Feature</th><th>Model</th><th>Purpose</th></tr>
      </thead>
      <tbody>
        <tr><td>Slug generation</td><td rowspan="4">Selected primary, then optional backup</td><td>Convert prompts to short branch names</td></tr>
        <tr><td>Commit messages and summaries</td><td>Describe git changes concisely</td></tr>
        <tr><td>Terminal names</td><td>Name settled regular terminals from recent screen output</td></tr>
        <tr><td>Pane status</td><td>Detect agent state from terminal output</td></tr>
      </tbody>
    </table>

    <h3>Without an Inference Provider</h3>
    <p>dmux still works without inference configured, with reduced automation:</p>
    <ul>
      <li>Branch names fall back to <code>dmux-{timestamp}</code></li>
      <li>Commit messages fall back to <code>dmux: auto-commit changes</code></li>
      <li>Regular terminals keep their stable <code>shell-N</code> names unless you rename them</li>
      <li>Pane status detection uses heuristics instead of LLM analysis</li>
    </ul>

    <div class="callout callout-tip">
      <div class="callout-title">Tip</div>
      Provider and model IDs are saved in dmux settings, but API keys are never written to project settings. Team defaults can name a provider/model while each developer supplies their own corresponding environment key.
    </div>

    <h2>Environment Variables</h2>
    <table>
      <thead>
        <tr><th>Variable</th><th>Description</th></tr>
      </thead>
      <tbody>
        <tr><td><code>OPENROUTER_API_KEY</code></td><td>OpenRouter</td></tr>
        <tr><td><code>OPENAI_API_KEY</code></td><td>OpenAI Platform API</td></tr>
        <tr><td><code>ANTHROPIC_API_KEY</code></td><td>Anthropic</td></tr>
        <tr><td><code>GOOGLE_GENERATIVE_AI_API_KEY</code></td><td>Google Gemini</td></tr>
        <tr><td><code>MISTRAL_API_KEY</code></td><td>Mistral AI</td></tr>
        <tr><td><code>TOGETHER_API_KEY</code></td><td>Together AI</td></tr>
        <tr><td><code>FIREWORKS_API_KEY</code></td><td>Fireworks AI</td></tr>
        <tr><td><code>PERPLEXITY_API_KEY</code></td><td>Perplexity</td></tr>
        <tr><td><code>COHERE_API_KEY</code></td><td>Cohere</td></tr>
        <tr><td><code>AI_GATEWAY_API_KEY</code></td><td>Vercel AI Gateway</td></tr>
        <tr><td><code>HF_TOKEN</code></td><td>Hugging Face inference router</td></tr>
        <tr><td><code>CEREBRAS_API_KEY</code></td><td>Cerebras Inference</td></tr>
        <tr><td><code>GROQ_API_KEY</code></td><td>Groq</td></tr>
        <tr><td><code>DEEPSEEK_API_KEY</code></td><td>DeepSeek</td></tr>
        <tr><td><code>XAI_API_KEY</code></td><td>xAI</td></tr>
        <tr><td><code>DMUX_SESSION</code></td><td>Override the tmux session name</td></tr>
      </tbody>
    </table>
  `;
}
