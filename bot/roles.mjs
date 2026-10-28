// Two roles (handbook/ROADMAP.md, этап 5): an editor runs the plan and the people, a member
// sends material and takes tasks. Owner and deputy are flags, not roles:
//   {role: 'editor'|'member', isOwner?, deputyUntil?: 'YYYY-MM-DD', onCamera?, web?, groups?: []}
// Older lists had owner / editor / viewer / author; they are read as the new shape.

export function normalize(p) {
  if (!p || p.role === 'editor' || p.role === 'member') return p;
  if (p.role === 'owner') return {...p, role: 'editor', isOwner: true};
  if (p.role === 'viewer') return {...p, role: 'member', web: true};
  return {...p, role: 'member'};
}

/** A deputy counts as an editor through the last day of their stand-in. */
export const isEditor = (p) => !!p && (p.role === 'editor' || p.isOwner === true || (!!p.deputyUntil && Date.parse(p.deputyUntil) + 864e5 > Date.now()));
