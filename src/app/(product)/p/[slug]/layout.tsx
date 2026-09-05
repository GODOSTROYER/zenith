"use client";
import { use, type ReactNode } from "react";
import { ErrorBoundary } from "@/components/shell/error-boundary";
import { ProjectProvider } from "@/components/shell/project-context";
import { ProjectChrome, ProjectChromeFallback } from "@/components/shell/project-chrome";

export default function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);

  return (
    <ProjectProvider
      key={slug}
      slug={slug}
      fallback={({ loading, error }) => (
        <ProjectChromeFallback
          loading={loading && !error}
          message={error?.message}
          fix={error?.fix}
        />
      )}
    >
      <ProjectChrome slug={slug}>
        <ErrorBoundary what="This project view">{children}</ErrorBoundary>
      </ProjectChrome>
    </ProjectProvider>
  );
}
