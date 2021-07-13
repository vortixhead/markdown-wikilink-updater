# Markdown Link and Wikilink Updater

This is a fork of this great plugin https://github.com/mathiassoeholm/markdown-link-updater

## Features

Updates Markdown links and wikilinks automatically, when files in the workspace are moved or renamed.

## Extension Settings

This extension contributes the following settings:

- `markdownLinkUpdater.exclude`: Array of glob patterns used to exclude specific folders and files. Default value is `['**/node_modules/**']`.
- `markdownLinkUpdater.include`: Array of glob patterns use to include specific folders and files. If the array is empty, everything will be included, unless specified by exclude. Default value is `[]`.

## Release Notes

See [CHANGELOG](CHANGELOG.md) for more information.
