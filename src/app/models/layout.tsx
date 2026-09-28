import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Models and evidence",
  description:
    "Every model GeoPulse trains, beside the naive baseline it has to beat on the same held-out data.",
};

export default function ModelsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
