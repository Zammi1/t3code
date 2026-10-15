import { createFileRoute, redirect } from "@tanstack/react-router";

import { RoleHubPage } from "../components/roleHubs/RoleHubPage";
import { isRoleHubId } from "../roleHubs/roleHubs.logic";

export const Route = createFileRoute("/_chat/hubs/$role")({
  beforeLoad: ({ params }) => {
    if (!isRoleHubId(params.role)) throw redirect({ to: "/", replace: true });
  },
  component: RoleHubRouteView,
});

function RoleHubRouteView() {
  const { role } = Route.useParams();
  return isRoleHubId(role) ? <RoleHubPage key={role} role={role} /> : null;
}
