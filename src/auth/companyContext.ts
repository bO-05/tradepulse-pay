import { createContext, useContext } from "react";

export type ActiveCompany = { name: string | null; isDemo: boolean };

export const ActiveCompanyContext = createContext<ActiveCompany>({ name: null, isDemo: false });

export function useActiveCompany(): ActiveCompany {
  return useContext(ActiveCompanyContext);
}
