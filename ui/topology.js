export function topologyLayout(groups) {
  const gap = 340
  const width = Math.max(gap, groups.length * gap)
  const regions = groups.map((group, index) => ({
    ...group,
    x: gap / 2 + index * gap,
    y: 150,
    nodes: group.members.map((node, position) => ({ node, y: 322 + position * 62 })),
  }))
  const links = regions.flatMap((source, index) => regions.slice(index + 1).map((target) => ({
    key: `${source.region}:${target.region}`,
    path: `M ${source.x} ${source.y} Q ${(source.x + target.x) / 2} ${Math.max(18, 85 - (target.x - source.x) / 8)} ${target.x} ${target.y}`,
  })))
  return { width, height: Math.max(430, 365 + Math.max(0, ...groups.map((group) => group.members.length)) * 62), regions, links }
}
