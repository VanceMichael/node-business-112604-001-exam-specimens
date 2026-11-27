import { HttpError } from './http-utils.mjs';

const CENTER_ROLES = ['frontdesk', 'doctor', 'collector', 'inspector', 'quality', 'admin'];

export function principalFor(req, catalog) {
  const authorization = req.headers.authorization || '';
  let token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token && typeof req.headers['x-api-key'] === 'string') token = req.headers['x-api-key'];
  if (!token) return { authenticated: false, roles: ['anonymous'], actorId: 'anonymous' };

  if (token === 'payment-gateway' || token === process.env.PAYMENT_KEY) {
    return { authenticated: true, actorId: 'payment-gateway', roles: ['paymentGateway'] };
  }
  const catalogActor = catalog.actors?.find(a => a.id === token);
  if (catalogActor) {
    const roles = Array.isArray(catalogActor.roles) ? catalogActor.roles : [catalogActor.role];
    return { authenticated: true, actorId: catalogActor.id, roles, labId: roles.includes('externalLab') ? catalogActor.id : undefined };
  }
  if (catalog.people.some(p => p.id === token)) {
    return { authenticated: true, actorId: token, roles: ['subject'], personId: token };
  }
  if (token === 'frontdesk-a') return { authenticated: true, actorId: token, roles: ['frontdesk'] };
  if (token === 'inspector-a') return { authenticated: true, actorId: token, roles: ['inspector'] };
  if (token === 'doctor-a') return { authenticated: true, actorId: token, roles: ['doctor'] };
  if (token === 'admin-a') return { authenticated: true, actorId: token, roles: ['admin'] };
  return { authenticated: false, roles: ['anonymous'], actorId: 'anonymous', invalidToken: true };
}

export function requireAuth(principal) {
  if (!principal.authenticated) throw new HttpError(401, 'UNAUTHORIZED', '请使用本说明中的合成 Bearer 身份办理');
}

export function requireRoles(principal, ...roles) {
  requireAuth(principal);
  if (principal.roles.includes('admin')) return;
  if (!roles.some(role => principal.roles.includes(role))) {
    throw new HttpError(403, 'FORBIDDEN_ROLE', `当前身份${principal.actorId}无权办理此操作`, { allowedRoles: roles });
  }
}

export function requireCenter(principal) {
  requireAuth(principal);
  if (!principal.roles.some(r => CENTER_ROLES.includes(r))) {
    throw new HttpError(403, 'CENTER_ROLE_REQUIRED', '该入口仅限中心人员办理');
  }
}

export function assertOwnPerson(principal, personId) {
  requireAuth(principal);
  if (principal.roles.includes('admin') || principal.roles.some(r => ['frontdesk', 'inspector', 'quality', 'collector'].includes(r))) return;
  if (principal.roles.includes('subject') && principal.personId === personId) return;
  throw new HttpError(403, 'PERSON_SCOPE_DENIED', '受检者只能办理本人的订单、同意、标本和报告');
}
