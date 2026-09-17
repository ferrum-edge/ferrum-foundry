import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ToastProvider } from "@/components/ui/Toast";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { NamespaceProvider } from "@/stores/namespace";
import { ErrorPopupProvider } from "@/stores/error";
import { ThemeProvider } from "@/stores/theme";
import { AuthProvider } from "@/stores/auth";
import { CapabilityProvider } from "@/stores/capabilities";
import { LoginGate } from "@/components/auth/LoginGate";
import { router } from "./router";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 300_000,
    },
  },
});

export function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ToastProvider>
            <TooltipProvider>
              <NamespaceProvider>
                <ErrorPopupProvider>
                  <LoginGate>
                    <CapabilityProvider>
                      <RouterProvider router={router} />
                    </CapabilityProvider>
                  </LoginGate>
                </ErrorPopupProvider>
              </NamespaceProvider>
            </TooltipProvider>
          </ToastProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
