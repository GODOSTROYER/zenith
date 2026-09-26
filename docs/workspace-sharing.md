# Workspace sharing

Every workspace has a **Share** entry in the product header, workspace switcher, and onboarding workspace list. Sharing also has a project-independent page at `/workspace?workspace=<id>`, so a workspace does not need a project before its owner can invite teammates. Existing **Settings → Members** links use the same controls.

## Roles and ownership

| Access | Read projects / preview plans | Edit / deploy | Manage settings | Invite or manage viewers and editors | Grant or change admin access | Transfer ownership |
| --- | --- | --- | --- | --- | --- | --- |
| Viewer | Yes | No | No | No | No | No |
| Editor | Yes | Yes, subject to environment policies | No | No | No | No |
| Admin | Yes | Yes, subject to environment policies | Yes | Yes | No | No |
| Owner | Yes | Yes, subject to environment policies | Yes | Yes | Yes | Yes |

Ownership is recorded separately from the membership role: the owner is also an admin. A workspace has one owner. Ownership transfer selects an existing member, requires the owner to type the workspace name, promotes the recipient to admin, and leaves the former owner as an admin. The owner cannot be removed, demoted, leave, or delete their account before transferring ownership. Other members can leave; the server also protects the last admin.

Workspace membership covers that workspace's projects. **Hosted app collaborators are separate**, and app-specific permissions still apply. Workspace membership does not create unauthenticated public access. Copying a workspace URL grants no permissions.

## Inviting and joining

1. Open **Share**, enter an email, and choose Viewer, Editor, or Admin. Viewer is the default. Only the owner can offer Admin access.
2. Copy the resulting invitation link and send it to the recipient. Zenith records the invitation but does **not send invitation email**.
3. The recipient signs in with the invited email, using an existing account or creating one. Email matching is case-insensitive.
4. At `/invite?invite=<id>`, the recipient reviews the workspace and offered role, then explicitly accepts. Acceptance selects that workspace and opens its overview. Accounts with no existing workspace can accept invitations.
5. All pending invitations for the signed-in email are available at `/invite` and **Workspace menu → Your invitations**.

New invitations expire after seven days. Admins can revoke or renew invitations within their role authority; the owner manages invitations offering Admin. Renewal supplies a link to share again. Expired invitations appear in the management list but cannot be accepted. Revoked and accepted invitations are excluded from the pending management list. Invite links require the addressed authenticated identity; the ID is not an anonymous access token. Missing or unavailable invitations show a generic explanation without disclosing another recipient's workspace.

Role changes and member removal require confirmation. Removal preserves created resources and audit history; subsequent workspace requests are denied. Once a workspace has an owner, operator role claims do not override persisted workspace role changes or re-admit removed members.

If installation-wide waitlist admission is enabled, an invitation does not bypass that admission gate.

## API

All management calls authenticate the actor and authorize against the selected workspace on the server. The UI supplies the expected workspace ID so a selection changed in another tab fails with HTTP 409 instead of editing a different workspace.

| Route | Purpose |
| --- | --- |
| `GET /api/workspace/sharing?workspaceId=<id>` | Workspace, members, current role, ownership and management capabilities. Invitations are only returned to admins. |
| `POST /api/workspace/invites` | Create an email-bound invitation: `{ email, role, workspaceId }`. Returns `{ invite, inviteUrl }`. |
| `DELETE /api/workspace/invites/:id?workspaceId=<id>` | Revoke an invitation. |
| `POST /api/workspace/invites/:id/resend` | Renew an invitation: `{ workspaceId }`. Returns the invitation and link; no mail is sent. |
| `PATCH /api/workspace/members/:id` | Change role: `{ role, workspaceId }`. |
| `DELETE /api/workspace/members/:id?workspaceId=<id>` | Remove a member. |
| `POST /api/workspace/ownership` | Transfer to an existing member: `{ memberId, workspaceId }`. |
| `POST /api/workspace/leave` | Leave the selected workspace: `{ workspaceId }`. Clears the selection cookie. |
| `GET /api/workspace/invitations` | Pending, unexpired invitations for the authenticated email, plus that email. Does not require existing workspace membership. |
| `POST /api/workspace/invites/:id/accept` | Accept the invitation as the authenticated email and select its workspace. Takes no client-supplied role or email. |

Legacy workspaces use a deterministic existing real admin as owner until ownership is persisted. Seeded placeholder identities cannot become owners through transfer. PostgreSQL deployments must apply the workspace sharing migration before using these routes; changes use transactional persistence and emit access-change audit events.

## Verification

Focused DOM coverage exercises viewer/editor restrictions, owner and admin boundaries, confirmation and cancellation, typed-name transfer, least-privilege invite defaults, clipboard fallback, API errors, stale workspace guards, first-workspace invitation acceptance, and invitation state handling. Server and database tests independently enforce the permission matrix and invitation lifecycle.
