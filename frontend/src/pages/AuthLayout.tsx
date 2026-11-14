import type { ReactNode } from "react";
import { Card } from "@heroui/react";
import { Logo } from "../components/Logo";

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-[#313338] bg-[radial-gradient(circle_at_20%_20%,#5865f233,transparent_40%),radial-gradient(circle_at_80%_80%,#eb459e22,transparent_40%)] p-6">
      <Card className="w-full max-w-md bg-[#2b2d31] p-2">
        <Card.Header className="items-center text-center">
          <div className="mb-3 flex flex-col items-center gap-2">
            <Logo size={72} />
            <span className="text-sm font-bold tracking-wide text-[#b5bac1]">TeAms</span>
          </div>
          <Card.Title className="text-2xl">{title}</Card.Title>
          <Card.Description>{subtitle}</Card.Description>
        </Card.Header>
        <Card.Content>{children}</Card.Content>
      </Card>
    </div>
  );
}
