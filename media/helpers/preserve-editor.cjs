// Owned non-interactive editor: accept Git's existing message unchanged.
// It never evaluates a repository/message as code and never writes another path.
const fs = require('node:fs');
const file = process.argv.at(-1);
if (!file || !fs.statSync(file).isFile() || fs.statSync(file).size > 1024 * 1024) process.exit(1);
