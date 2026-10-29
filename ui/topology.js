export function topologyLayout(groups, routes = []) {
  const gap = 340
  const width = Math.max(gap, groups.length * gap)
  const regions = groups.map((group, index) => {
    const regionRoutes = routes.filter((route) => route.region === group.region)
    return {
      ...group,
      x: gap / 2 + index * gap,
      y: 150,
      routes: regionRoutes,
      nodes: group.members.map((node, position) => ({ node, y: 322 + regionRoutes.length * 18 + position * 62 })),
    }
  })
  const links = regions.flatMap((source, index) => regions.slice(index + 1).map((target) => ({
    key: `${source.region}:${target.region}`,
    path: `M ${source.x} ${source.y} Q ${(source.x + target.x) / 2} ${Math.max(18, 85 - (target.x - source.x) / 8)} ${target.x} ${target.y}`,
  })))
  return { width, height: Math.max(430, ...regions.map((region) => 365 + region.routes.length * 18 + region.members.length * 62)), regions, links }
}
