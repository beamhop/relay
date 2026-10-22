import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as jsxRuntime from "react/jsx-runtime";
import { toast } from "sonner";
import type { AdminUiHost } from "@beamhop/sdk/ui-contract";
import * as AlertDialog from "@/components/ui/alert-dialog";
import * as Avatar from "@/components/ui/avatar";
import * as Badge from "@/components/ui/badge";
import * as Button from "@/components/ui/button";
import * as Card from "@/components/ui/card";
import * as Checkbox from "@/components/ui/checkbox";
import * as Dialog from "@/components/ui/dialog";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import * as Input from "@/components/ui/input";
import * as Label from "@/components/ui/label";
import * as Popover from "@/components/ui/popover";
import * as Progress from "@/components/ui/progress";
import * as ScrollArea from "@/components/ui/scroll-area";
import * as Select from "@/components/ui/select";
import * as Separator from "@/components/ui/separator";
import * as Sheet from "@/components/ui/sheet";
import * as Skeleton from "@/components/ui/skeleton";
import * as Switch from "@/components/ui/switch";
import * as Table from "@/components/ui/table";
import * as Tabs from "@/components/ui/tabs";
import * as Textarea from "@/components/ui/textarea";
import * as Tooltip from "@/components/ui/tooltip";
import * as ToggleGroup from "@/components/ui/toggle-group";
import * as Chart from "@/components/ui/chart";
import { UserAvatar } from "@/components/user-avatar";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { cn } from "@/lib/utils";

declare global {
  interface Window {
    __BEAMHOP_UI__?: AdminUiHost;
  }
}

export function installHost() {
  if (window.__BEAMHOP_UI__) return;
  const ui: Record<string, unknown> = {
    ...AlertDialog, ...Avatar, ...Badge, ...Button, ...Card, ...Checkbox, ...Dialog, ...DropdownMenu, ...Input, ...Label,
    ...Popover, ...Progress, ...ScrollArea, ...Select, ...Separator, ...Sheet, ...Skeleton, ...Switch, ...Table, ...Tabs,
    ...Textarea, ...Tooltip, ...ToggleGroup, ...Chart,
    UserAvatar, EmptyState, PageHeader, cn,
  };
  window.__BEAMHOP_UI__ = {
    React,
    ReactDOM: { ...ReactDOM, ...ReactDOMClient },
    jsxRuntime,
    ui,
    toast,
  };
}
