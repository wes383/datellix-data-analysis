import { redirect } from "next/navigation";

/**
 * Home — redirect to a fresh pending session instead of showing a blank
 * placeholder. The pending session (`/chat/new`) doesn't create a DB
 * row until the first message is sent.
 */
export default function HomePage() {
  redirect("/chat/new");
}
