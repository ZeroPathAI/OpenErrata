export interface IntegrationTestCommand {
  command: string;
  args: string[];
}

const INTEGRATION_TEST_RUNNER_ARGS = [
  "tsx",
  "--test",
  "--test-concurrency=1",
  "test/integration/*.integration.test.ts",
];

const EXEC_PREFIX_FLAG = "--exec-prefix";
const EXEC_PREFIX_DELIMITER = "--";

export function buildIntegrationTestCommand(
  forwardedArgs: readonly string[],
): IntegrationTestCommand {
  const execPrefixIndex = forwardedArgs.indexOf(EXEC_PREFIX_FLAG);
  if (execPrefixIndex === -1) {
    const args = ["run", "test:integration:raw"];
    if (forwardedArgs.length > 0) {
      args.push("--", ...forwardedArgs);
    }
    return {
      command: "pnpm",
      args,
    };
  }

  const argsBeforePrefix = forwardedArgs.slice(0, execPrefixIndex);
  const argsAfterPrefixFlag = forwardedArgs.slice(execPrefixIndex + 1);

  if (argsAfterPrefixFlag.length === 0) {
    throw new Error(
      "--exec-prefix requires at least one token. Use --exec-prefix <command> [args...] -- [test args]",
    );
  }

  const delimiterIndex = argsAfterPrefixFlag.indexOf(EXEC_PREFIX_DELIMITER);
  const execPrefixTokens =
    delimiterIndex === -1 ? argsAfterPrefixFlag : argsAfterPrefixFlag.slice(0, delimiterIndex);
  if (execPrefixTokens.length === 0) {
    throw new Error("--exec-prefix requires at least one token before --");
  }

  const [execCommand, ...execPrefixArgs] = execPrefixTokens;
  if (execCommand === undefined || execCommand.trim().length === 0) {
    throw new Error("--exec-prefix command must not be empty");
  }
  if (/\s/.test(execCommand)) {
    throw new Error(
      "--exec-prefix command must be tokenized. Pass --exec-prefix <command> [args...] instead of a quoted string.",
    );
  }

  const argsAfterDelimiter =
    delimiterIndex === -1 ? [] : argsAfterPrefixFlag.slice(delimiterIndex + 1);

  return {
    command: "pnpm",
    args: [
      "exec",
      execCommand,
      ...execPrefixArgs,
      ...INTEGRATION_TEST_RUNNER_ARGS,
      ...argsBeforePrefix,
      ...argsAfterDelimiter,
    ],
  };
}
