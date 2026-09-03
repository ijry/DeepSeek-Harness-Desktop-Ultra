import { Boundaries } from "./components/Boundaries";
import { Download } from "./components/Download";
import { Faq } from "./components/Faq";
import { Features } from "./components/Features";
import { Flow } from "./components/Flow";
import { Footer } from "./components/Footer";
import { Hero } from "./components/Hero";
import { Limits } from "./components/Limits";
import { Nav } from "./components/Nav";

export default function App() {
  return (
    <>
      <a className="skip" href="#download">
        skip to content
      </a>
      <div className="bg" aria-hidden="true">
        <span className="bg__orb bg__orb--a" />
        <span className="bg__orb bg__orb--b" />
        <span className="bg__grid" />
      </div>
      <Nav />
      <main>
        <Hero />
        <Download />
        <Features />
        <Flow />
        <Boundaries />
        <Limits />
        <Faq />
      </main>
      <Footer />
    </>
  );
}