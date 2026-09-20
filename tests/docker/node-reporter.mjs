export default async function* reporter(events) {
  for await (const event of events) {
    if (["test:pass", "test:fail"].includes(event.type))
      yield JSON.stringify({ nodeTest: { type: event.type, ...event.data } }) + "\n";
    else if (event.type === "test:diagnostic") yield event.data.message + "\n";
  }
}
