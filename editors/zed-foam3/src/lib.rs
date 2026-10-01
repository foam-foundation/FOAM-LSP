use zed_extension_api::{self as zed, settings::LspSettings, Command, LanguageServerId, Result, Worktree};

struct Foam3Extension;

impl zed::Extension for Foam3Extension {
    fn new() -> Self {
        Foam3Extension
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Command> {
        // Allow users to override the binary path via Zed settings:
        //   "lsp": { "foam3-lsp": { "binary": { "path": "/usr/local/bin/node", "arguments": [...] } } }
        let settings = LspSettings::for_worktree(language_server_id.as_ref(), worktree).ok();

        let node_path = settings
            .as_ref()
            .and_then(|s| s.binary.as_ref())
            .and_then(|b| b.path.clone())
            .or_else(|| worktree.which("node"))
            .unwrap_or_else(|| "node".to_string());

        // The LSP lives in the FOAM-LSP clone ./build.sh lsp-install creates:
        // $FOAM_LSP_HOME, or ~/.foam/lsp. It loads the workspace's own foam3.
        let env = worktree.shell_env();
        let var = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        let lsp_home = var("FOAM_LSP_HOME")
            .or_else(|| var("HOME").map(|h| format!("{}/.foam/lsp", h)))
            .unwrap_or_else(|| ".foam/lsp".to_string());
        let default_args = vec![format!("{}/bin/lsp-start.js", lsp_home)];

        let args = settings
            .as_ref()
            .and_then(|s| s.binary.as_ref())
            .and_then(|b| b.arguments.clone())
            .unwrap_or(default_args);

        Ok(Command {
            command: node_path,
            args,
            env: Default::default(),
        })
    }
}

zed::register_extension!(Foam3Extension);
