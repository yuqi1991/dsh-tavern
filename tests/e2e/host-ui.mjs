// DSH 0.2.x keeps Settings in the account menu; 0.1.x had a sidebar button.
export async function openHostSettings(page) {
  const settings = page.getByRole('button', { name: 'Settings', exact: true }).or(page.getByRole('menuitem', { name: 'Settings', exact: true }))
  if (!await settings.count()) await page.getByRole('button', { name: 'Account menu' }).click()
  await settings.first().click()
}
