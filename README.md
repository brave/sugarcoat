# SugarCoat

This is used in the [SugarCoat pipeline](https://github.com/brave-experiments/sugarcoat-pipeline) to generate privacy-preserving versions of tracking scripts.

## Development

[pnpm](https://pnpm.js.org/) is recommended for managing a JavaScript development environment for
SugarCoat.

To initialize an isolated JavaScript development environment:

```
pnpm install
```

### Code Formatting

Code formatting for JavaScript is handled by [prettierx](https://github.com/brodybits/prettierx),
with a few [options](.prettierrc.toml) tweaked.

To check that the code is correctly formatted:

```
pnpm run check
```

To auto-format the code:

```
pnpm run fmt
```
