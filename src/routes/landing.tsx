/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – landing route                                     */
/*                                                                     */
/*  The Dashboard summarizes fleet-wide health, metrics, and overload, */
/*  which the BFF refuses to a session holding namespace grants. Such  */
/*  a session lands on its namespace's proxies instead; only an        */
/*  unrestricted session gets the Dashboard.                           */
/* ------------------------------------------------------------------ */

import { lazy } from "react";
import { Navigate } from "@tanstack/react-router";
import { useAuth } from "@/stores/auth";

const DashboardPage = lazy(() => import("@/routes/dashboard/index"));

export default function LandingPage() {
  const { principal } = useAuth();
  if (principal?.namespaces !== undefined) return <Navigate to="/proxies" replace />;
  return <DashboardPage />;
}
