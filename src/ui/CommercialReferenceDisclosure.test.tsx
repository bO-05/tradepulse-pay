// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { CommercialReferenceDisclosure } from "./CommercialReferenceDisclosure";

function render(count: number, children = <a href="#/record">Record</a>) {
  return renderToStaticMarkup(
    <CommercialReferenceDisclosure count={count} testId="demo-commercial" summaryTestId="demo-commercial-summary">
      {children}
    </CommercialReferenceDisclosure>,
  );
}

describe("CommercialReferenceDisclosure", () => {
  test("is one native disclosure, titled with the true count and initially closed", () => {
    const html = render(3);
    expect(html.match(/<details/g) ?? []).toHaveLength(1);
    expect(html).toContain('data-testid="demo-commercial"');
    expect(html).toContain('data-testid="demo-commercial-summary"');
    expect(html).toContain('data-record-count="3"');
    expect(html).toContain("Commercial reference job (3)");
    const details = html.slice(html.indexOf("<details"), html.indexOf(">", html.indexOf("<details")) + 1);
    expect(details).not.toContain(" open");
  });

  test("keeps every child in the DOM so expansion restores the records and links", () => {
    const html = render(
      2,
      <>
        <a href="#/one">One</a>
        <a href="#/two">Two</a>
      </>,
    );
    expect(html).toContain('href="#/one"');
    expect(html).toContain('href="#/two"');
  });

  test("names the Show and Hide affordances in words, never colour alone", () => {
    const html = render(1);
    expect(html).toContain(">Show<");
    expect(html).toContain(">Hide<");
  });
});
