import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { ErrorPopup } from "@/components/shared/ErrorPopup";

interface ErrorState {
  open: boolean;
  statusCode: number;
  body: string;
  url: string;
}

interface ShowErrorParams {
  statusCode: number;
  body: string;
  url: string;
}

interface ErrorPopupContextValue {
  state: ErrorState;
  showError: (params: ShowErrorParams) => void;
  hideError: () => void;
}

const ErrorPopupContext = createContext<ErrorPopupContextValue | null>(null);

const initialState: ErrorState = {
  open: false,
  statusCode: 0,
  body: "",
  url: "",
};

export function ErrorPopupProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ErrorState>(initialState);

  const showError = useCallback((params: ShowErrorParams) => {
    setState({ open: true, ...params });
  }, []);

  const hideError = useCallback(() => {
    setState(initialState);
  }, []);

  return (
    <ErrorPopupContext.Provider value={{ state, showError, hideError }}>
      {children}
      <ErrorPopup
        open={state.open}
        statusCode={state.statusCode}
        body={state.body}
        url={state.url}
        onClose={hideError}
      />
    </ErrorPopupContext.Provider>
  );
}

export function useErrorPopup(): ErrorPopupContextValue {
  const ctx = useContext(ErrorPopupContext);
  if (!ctx) {
    throw new Error("useErrorPopup must be used within an ErrorPopupProvider");
  }
  return ctx;
}
