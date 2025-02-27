const resolvePath = require("object-resolve-path");
const {
  RESULT_MERGED,
  RESULT_MERGE_FAILED,
  RESULT_AUTHOR_FILTERED,
  RESULT_NOT_READY,
  RESULT_SKIPPED,
  logger,
  retry
} = require("./common");

const MAYBE_READY = ["clean", "has_hooks", "unknown", "unstable"];
const NOT_READY = ["dirty", "draft"];

const PR_PROPERTY = new RegExp("{pullRequest.([^}]+)}", "g");

async function merge(context, pullRequest, approvalCount) {
  if (skipPullRequest(context, pullRequest, approvalCount)) {
    return RESULT_SKIPPED;
  }

  logger.info(`Merging PR #${pullRequest.number} ${pullRequest.title}`);

  const {
    head: { sha }
  } = pullRequest;

  const {
    octokit,
    config: {
      mergeMethod: defaultMergeMethod,
      mergeMethodLabels,
      mergeCommitMessage,
      mergeCommitMessageRegex,
      mergeFilterAuthor,
      mergeRemoveLabels,
      mergeRetries,
      mergeRetrySleep,
      mergeErrorFail
    }
  } = context;

  const ready = await waitUntilReady(pullRequest, context);
  if (!ready) {
    return RESULT_NOT_READY;
  }

  if (mergeCommitMessageRegex) {
    // If we find the regex, use the first capturing subgroup as new body (discarding whitespace).
    const m = new RegExp(mergeCommitMessageRegex, "sm").exec(pullRequest.body);
    if (m) {
      if (m[1] === undefined) {
        throw new Error(
          `MERGE_COMMIT_MESSAGE_REGEX must contain a capturing subgroup: '${mergeCommitMessageRegex}'`
        );
      }
      pullRequest.body = m[1].trim();
    }
  }

  if (mergeFilterAuthor && pullRequest.user.login !== mergeFilterAuthor) {
    logger.info(
      `PR author '${pullRequest.user.login}' does not match filter:`,
      mergeFilterAuthor
    );
    return RESULT_AUTHOR_FILTERED;
  }

  const commitMessage = getCommitMessage(mergeCommitMessage, pullRequest);
  const mergeMethod = getMergeMethod(
    defaultMergeMethod,
    mergeMethodLabels,
    pullRequest
  );
  const merged = await tryMerge(
    octokit,
    pullRequest,
    sha,
    mergeMethod,
    mergeRetries,
    mergeRetrySleep,
    mergeErrorFail,
    commitMessage
  );
  if (!merged) {
    return RESULT_MERGE_FAILED;
  }

  logger.info("PR successfully merged!");

  try {
    await removeLabels(octokit, pullRequest, mergeRemoveLabels);
  } catch (e) {
    logger.info("Failed to remove labels:", e.message);
  }

  if (context.config.mergeDeleteBranch) {
    try {
      await deleteBranch(
        octokit,
        pullRequest,
        context.config.mergeDeleteBranchFilter
      );
    } catch (e) {
      logger.info("Failed to delete branch:", e.message);
    }
  }

  return RESULT_MERGED;
}

async function removeLabels(octokit, pullRequest, mergeRemoveLabels) {
  const labels = pullRequest.labels.filter(label =>
    mergeRemoveLabels.includes(label.name)
  );

  if (labels.length < 1) {
    logger.debug("No labels to remove.");
    return;
  }

  const labelNames = labels.map(label => label.name);

  logger.debug("Removing labels:", labelNames);

  for (const name of labelNames) {
    await octokit.issues.removeLabel({
      owner: pullRequest.base.repo.owner.login,
      repo: pullRequest.base.repo.name,
      issue_number: pullRequest.number,
      name
    });
  }

  logger.info("Removed labels:", labelNames);
}

async function deleteBranch(octokit, pullRequest, mergeDeleteBranchFilter) {
  if (pullRequest.head.repo.full_name !== pullRequest.base.repo.full_name) {
    logger.info("Branch is from external repository, skipping delete");
    return;
  }

  const branchQuery = {
    owner: pullRequest.head.repo.owner.login,
    repo: pullRequest.head.repo.name,
    branch: pullRequest.head.ref
  };

  const { data: branch } = await octokit.repos.getBranch(branchQuery);

  logger.trace("Branch:", branch);

  if (branch.protected) {
    const { data: protectionRules } = await octokit.repos.getBranchProtection(
      branchQuery
    );
    if (
      protectionRules.allow_deletions &&
      !protectionRules.allow_deletions.enabled
    ) {
      logger.info("Branch is protected and cannot be deleted:", branch.name);
      return;
    }
  } else if (mergeDeleteBranchFilter.includes(branch.name)) {
    logger.info(
      "Branch is in filter list and will not be deleted:",
      branch.name
    );
  } else {
    logger.debug("Deleting branch", branch.name, "...");
    await octokit.git.deleteRef({
      owner: pullRequest.head.repo.owner.login,
      repo: pullRequest.head.repo.name,
      ref: `heads/${branch.name}`
    });
    logger.info("Merged branch has been deleted:", branch.name);
  }
}

function skipPullRequest(context, pullRequest, approvalCount) {
  const {
    config: {
      mergeForks,
      mergeLabels,
      mergeRequiredApprovals,
      mergeMethodLabelRequired,
      mergeMethodLabels,
      baseBranches
    }
  } = context;

  let skip = false;

  if (pullRequest.state !== "open") {
    logger.info("Skipping PR merge, state is not open:", pullRequest.state);
    skip = true;
  }

  if (pullRequest.merged === true) {
    logger.info("Skipping PR merge, already merged!");
    skip = true;
  }

  if (pullRequest.head.repo.full_name !== pullRequest.base.repo.full_name) {
    if (!mergeForks) {
      logger.info("PR is a fork and MERGE_FORKS is false, skipping merge");
      skip = true;
    }
  }

  const labels = pullRequest.labels.map(label => label.name);

  for (const label of pullRequest.labels) {
    if (mergeLabels.blocking.includes(label.name)) {
      logger.info("Skipping PR merge, blocking label present:", label.name);
      skip = true;
    }
  }

  for (const required of mergeLabels.required) {
    if (!labels.includes(required)) {
      logger.info("Skipping PR merge, required label missing:", required);
      skip = true;
    }
  }

  if (approvalCount < mergeRequiredApprovals) {
    logger.info(
      `Skipping PR merge, missing ${
        mergeRequiredApprovals - approvalCount
      } approvals`
    );
    skip = true;
  }

  const numberMethodLabelsFound = mergeMethodLabels
    .map(lm => labels.includes(lm.label))
    .filter(x => x).length;
  if (mergeMethodLabelRequired && numberMethodLabelsFound === 0) {
    logger.info("Skipping PR merge, required merge method label missing");
    skip = true;
  }

  if (
    baseBranches &&
    baseBranches.length &&
    !baseBranches.some(branch => branch === pullRequest.base.ref)
  ) {
    logger.info(
      "Skipping PR merge, base branch is not in the provided list:",
      baseBranches
    );
    skip = true;
  }

  return skip;
}

function waitUntilReady(pullRequest, context) {
  const {
    octokit,
    config: { mergeRetries, mergeRetrySleep, mergeErrorFail }
  } = context;

  return retry(
    mergeRetries,
    mergeRetrySleep,
    () => checkReady(pullRequest, context),
    async () => {
      const pr = await getPullRequest(octokit, pullRequest);
      return checkReady(pr, context);
    },
    () => failOrInfo(mergeRetries, mergeErrorFail)
  );
}

function checkReady(pullRequest, context) {
  if (skipPullRequest(context, pullRequest)) {
    return "failure";
  }
  return mergeable(pullRequest);
}

function mergeable(pullRequest) {
  const { mergeable_state } = pullRequest;
  if (mergeable_state == null || MAYBE_READY.includes(mergeable_state)) {
    logger.info("PR is probably ready: mergeable_state:", mergeable_state);
    return "success";
  } else if (NOT_READY.includes(mergeable_state)) {
    logger.info("PR not ready: mergeable_state:", mergeable_state);
    return "failure";
  } else {
    logger.info("Current PR status: mergeable_state:", mergeable_state);
    return "retry";
  }
}

async function getPullRequest(octokit, pullRequest) {
  logger.debug("Getting latest PR data...");
  const { data: pr } = await octokit.pulls.get({
    owner: pullRequest.base.repo.owner.login,
    repo: pullRequest.base.repo.name,
    pull_number: pullRequest.number,
    headers: { "If-None-Match": "" }
  });

  logger.trace("PR:", pr);

  return pr;
}

function tryMerge(
  octokit,
  pullRequest,
  head,
  mergeMethod,
  mergeRetries,
  mergeRetrySleep,
  mergeErrorFail,
  commitMessage
) {
  return retry(
    mergeRetries,
    mergeRetrySleep,
    () =>
      mergePullRequest(octokit, pullRequest, head, mergeMethod, commitMessage),
    async () => {
      const pr = await getPullRequest(octokit, pullRequest);
      if (pr.merged === true) {
        return "success";
      }
      return mergePullRequest(
        octokit,
        pullRequest,
        head,
        mergeMethod,
        commitMessage
      );
    },
    () => failOrInfo(mergeRetries, mergeErrorFail)
  );
}

function failOrInfo(mergeRetries, mergeErrorFail) {
  const message = `PR not ready to be merged after ${mergeRetries} tries`;
  if (mergeErrorFail) {
    logger.error(message);
    process.exit(1);
  } else {
    logger.info(message);
  }
}

function getMergeMethod(defaultMergeMethod, mergeMethodLabels, pullRequest) {
  const foundMergeMethodLabels = pullRequest.labels.flatMap(l =>
    mergeMethodLabels.filter(ml => ml.label === l.name)
  );
  if (foundMergeMethodLabels.length > 0) {
    const first = foundMergeMethodLabels[0];
    if (foundMergeMethodLabels.length > 1) {
      throw new Error(
        `Discovered multiple merge method labels, only one is permitted!`
      );
    } else {
      logger.info(
        `Discovered ${first.label}, will merge with method ${first.method}`
      );
    }
    return first.method;
  }
  return defaultMergeMethod;
}

function getCommitMessage(mergeCommitMessage, pullRequest) {
  if (mergeCommitMessage === "automatic") {
    return undefined;
  } else if (mergeCommitMessage === "pull-request-title") {
    return pullRequest.title;
  } else if (mergeCommitMessage === "pull-request-description") {
    return pullRequest.body;
  } else if (mergeCommitMessage === "pull-request-title-and-description") {
    return (
      pullRequest.title + (pullRequest.body ? "\n\n" + pullRequest.body : "")
    );
  } else {
    return mergeCommitMessage.replace(PR_PROPERTY, (_, prProp) =>
      resolvePath(pullRequest, prProp)
    );
  }
}

async function mergePullRequest(
  octokit,
  pullRequest,
  head,
  mergeMethod,
  commitMessage
) {
  try {
    await octokit.pulls.merge({
      owner: pullRequest.base.repo.owner.login,
      repo: pullRequest.base.repo.name,
      pull_number: pullRequest.number,
      commit_title: commitMessage,
      commit_message: "",
      sha: head,
      merge_method: mergeMethod
    });
    return "success";
  } catch (e) {
    return checkMergeError(e);
  }
}

function checkMergeError(e) {
  const m = e ? e.message || "" : "";
  if (
    m.includes("review is required by reviewers with write access") ||
    m.includes("reviews are required by reviewers with write access") ||
    m.includes("API rate limit exceeded")
  ) {
    logger.info("Cannot merge PR:", m);
    return "failure";
  } else {
    logger.info("Failed to merge PR:", m);
    return "retry";
  }
}

module.exports = { merge };
