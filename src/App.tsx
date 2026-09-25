import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ToastProvider } from "@/components/ui/Toast";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { NamespaceProvider } from "@/stores/namespace";
import { ErrorPopupProvider } from "@/stores/error";
import { ThemeProvider } from "@/stores/theme";
import { AuthProvider } from "@/stores/auth";
import { CapabilityProvider } from "@/stores/capabilities";
import { GatewayTargetGate } from "@/components/auth/GatewayTargetGate";
import { LoginGate } from "@/components/auth/LoginGate";
import { createQueryClient } from "@/lib/queryClient";
import { router } from "./router";

const queryClient = createQueryClient();

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
                    <GatewayTargetGate>
                      <CapabilityProvider>
                        <RouterProvider router={router} />
                      </CapabilityProvider>
                    </GatewayTargetGate>
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
