import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const RELEASE_TAG_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?$/;

export function parseReleaseTag(tag) {
  const match = RELEASE_TAG_PATTERN.exec(tag);
  if (!match) {
    throw new Error('Release tag must be vMAJOR.MINOR.PATCH with an optional safe prerelease suffix');
  }
  return {
    tag,
    version: tag.slice(1),
    majorMinor: `${match[1]}.${match[2]}`,
    stable: match[4] === undefined,
    numeric: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
  };
}

function compareNumeric(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
}

export function releaseChannelPolicy(currentTag, repositoryTags) {
  const current = parseReleaseTag(currentTag);
  const stableTags = repositoryTags.flatMap((tag) => {
    try {
      const parsed = parseReleaseTag(tag);
      return parsed.stable ? [parsed] : [];
    } catch {
      return [];
    }
  });
  const hasNewerStable = stableTags.some((tag) => compareNumeric(tag.numeric, current.numeric) > 0);
  const hasNewerPatch = stableTags.some((tag) => (
    tag.numeric[0] === current.numeric[0]
    && tag.numeric[1] === current.numeric[1]
    && tag.numeric[2] > current.numeric[2]
  ));
  return {
    tag: current.tag,
    version: current.version,
    majorMinor: current.majorMinor,
    stable: current.stable,
    advanceLatest: current.stable && !hasNewerStable,
    advanceMajorMinor: current.stable && !hasNewerPatch,
  };
}

function main() {
  const releaseTag = process.env.RELEASE_TAG;
  if (!releaseTag) throw new Error('RELEASE_TAG is required');
  const tags = execFileSync('git', ['tag', '--list'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const policy = releaseChannelPolicy(releaseTag, tags);
  process.stdout.write([
    `tag=${policy.tag}`,
    `version=${policy.version}`,
    `major_minor=${policy.majorMinor}`,
    `stable=${policy.stable}`,
    `advance_latest=${policy.advanceLatest}`,
    `advance_major_minor=${policy.advanceMajorMinor}`,
  ].join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Release tag validation failed');
    process.exitCode = 1;
  }
}
